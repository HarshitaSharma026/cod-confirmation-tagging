require("dotenv").config();
const express = require("express");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SHOP = process.env.SHOP;
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const API_VERSION = "2026-01";

/* ================= HELPERS ================= */

const sleep = ms => new Promise(r => setTimeout(r, ms));
const buildRequestTag = requestId => `MSG91_${requestId}`;

/* ================= HEALTH ================= */

app.get("/", (_, res) => {
  res.send("COD Confirmation Server Running");
});


/* ================= OUTBOUND WEBHOOK ================= */

app.post("/msg91/outbound", async (req, res) => {
  try {
    
    console.log("🔥 OUTBOUND HIT 🔥");


    // const { requestId, content, eventName } = req.body;
    const { requestId, content, eventName, templateName } = req.body;
    

    if (eventName !== "delivered") {
      return res.status(200).json({ ignored: "Not a delivered event" });
    }

    if (templateName !== "cod_order_confirmation_test") {
      return res.status(200).json({ ignored: "Not COD template" });
    }
    console.log("OUTBOUND PAYLOAD:", JSON.stringify(req.body, null, 2));
    if (!requestId || !content) {
      return res.status(200).json({ ignored: "Missing requestId or content" });
    }

    /* -------------------------------
       1. Parse template content
    -------------------------------- */
    let parsedContent;
    try {
      parsedContent = JSON.parse(content);
    } catch (e) {
      console.error("CONTENT PARSE FAILED");
      return res.status(200).json({ ignored: "Invalid content JSON" });
    }

    // body_2.text = "#V1592"
    const orderText = parsedContent?.body_2?.text || "";
    console.log("RAW body_2.text:", parsedContent?.body_2?.text);
    console.log("orderText variable:", orderText);


    // Extract numeric order number -> "1592"
    const orderNumber = orderText.replace(/[^0-9]/g, "");

    if (!orderText) {
      return res.status(200).json({ ignored: "Order number not found in template" });
    }

    // const shopifyOrderName = `#${orderNumber}`;
    console.log("MATCHING ORDER NAME:", orderText);

    /* -------------------------------
       2. Find order in Shopify
    -------------------------------- */
    let order = null;

for (let attempt = 1; attempt <= 6; attempt++) {
  console.log(`ORDER SEARCH ATTEMPT ${attempt} for ${orderNumber}`);

  const findOrderQuery = `
    query {
      orders(first: 1, query: "name:${orderNumber}") {
        edges {
          node {
            id
            name
            tags
          }
        }
      }
    }
  `;

  const orderRes = await fetch(
    `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_TOKEN
      },
      body: JSON.stringify({ query: findOrderQuery })
    }
  );

  const orderData = await orderRes.json();
    order = orderData?.data?.orders?.edges?.[0]?.node;

    if (order) break;

    // wait before retrying
    await sleep(5000); // 5 seconds
}

  if (!order) {
    return res.status(200).json({
      ignored: "Order not found after retries",
      orderNameTried: orderText
    });
  }


    /* -------------------------------
       3. Build requestId tag
    -------------------------------- */
    const requestTag = `MSG91_${requestId}`;

    // Idempotency check
    if (order.tags.includes(requestTag)) {
      return res.status(200).json({ ignored: "RequestId tag already exists" });
    }

    /* -------------------------------
       4. Add tag to order
    -------------------------------- */
    const addTagMutation = `
      mutation {
        tagsAdd(
          id: "${order.id}"
          tags: ["${requestTag}"]
        ) {
          userErrors {
            field
            message
          }
        }
      }
    `;

    const updateRes = await fetch(
      `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": SHOPIFY_TOKEN
        },
        body: JSON.stringify({ query: addTagMutation })
      }
    );

    const updateData = await updateRes.json();

    console.log("TAG ADD RESPONSE:", JSON.stringify(updateData, null, 2));

    if (updateData.errors || updateData?.data?.tagsAdd?.userErrors?.length) {
      console.error("TAGGING FAILED");
      return res.status(500).json({ error: "Failed to add requestId tag" });
    }

    /* -------------------------------
       5. Success
    -------------------------------- */
    res.status(200).json({
      success: true,
      orderName: order.name,
      tagAdded: requestTag
    });

  } catch (err) {
    console.error("OUTBOUND HANDLER ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});


/* ================= INBOUND WEBHOOK ================= */

app.post("/msg91/webhook", async (req, res) => {
  try {
    console.log("INBOUND:", JSON.stringify(req.body, null, 2));

    if (
      req.body.contentType !== "button" ||
      !req.body.button ||
      req.body.templateName !== "cod_order_confirmation_test"
    ) {
      return res.status(200).json({ ignored: "Not COD confirmation" });
    }

    const { requestId } = req.body;
    const btn = JSON.parse(req.body.button);

    if (btn.payload !== "YES") {
      return res.status(200).json({ ignored: "Not YES" });
    }

    const requestTag = buildRequestTag(requestId);

    const query = `
      query {
        orders(first: 1, query: "tag:${requestTag}") {
          edges {
            node {
              id
              tags
              paymentGatewayNames
            }
          }
        }
      }
    `;

    const orderRes = await fetch(
      `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": SHOPIFY_TOKEN
        },
        body: JSON.stringify({ query })
      }
    );

    const orderData = await orderRes.json();
    const order = orderData?.data?.orders?.edges?.[0]?.node;

    if (!order) {
      return res.status(200).json({ ignored: "Order not found" });
    }

    if (order.tags.includes("cod_confirmed")) {
      return res.status(200).json({ ignored: "Already confirmed" });
    }

    const mutation = `
      mutation {
        tagsAdd(
          id: "${order.id}"
          tags: ["cod_confirmed"]
        ) {
          userErrors { message }
        }
      }
    `;

    await fetch(
      `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": SHOPIFY_TOKEN
        },
        body: JSON.stringify({ query: mutation })
      }
    );

    res.status(200).json({ success: true });

  } catch (err) {
    console.error("Inbound error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ================= START ================= */

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
