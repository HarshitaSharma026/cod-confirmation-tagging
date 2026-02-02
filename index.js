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

/* =========================
   Helpers
   ========================= */
const buildRequestTag = (requestId) => `MSG91_${requestId}`;

/* Health check */
app.get("/", (_, res) => {
  res.send("COD Confirmation Server Running");
});

/* =========================
   OUTBOUND WEBHOOK (MSG SENT)
   ========================= */
app.post("/msg91/outbound", async (req, res) => {
  try {
    console.log("OUTBOUND:", JSON.stringify(req.body, null, 2));

    const { requestId, content } = req.body;
    if (!requestId || !content) {
      return res.status(200).json({ ignored: "Missing requestId or content" });
    }

    // Extract order number from template content
    const parsedContent = JSON.parse(content);
    const orderText = parsedContent?.body_2?.text || ""; // "#V1543"
    const orderNumber = orderText.replace("#", "").trim();

    if (!orderNumber) {
      return res.status(200).json({ ignored: "Order number not found" });
    }

    /* 1. Find order by order number (name) */
    const findOrderQuery = `
      query {
        orders(first: 1, query: "name:#${orderNumber}") {
          edges {
            node {
              id
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
    const order = orderData?.data?.orders?.edges?.[0]?.node;

    if (!order) {
      return res.status(200).json({ ignored: "Order not found" });
    }

    const requestTag = buildRequestTag(requestId);

    // Avoid duplicate tagging
    if (order.tags.includes(requestTag)) {
      return res.status(200).json({ ignored: "Request tag already exists" });
    }

    /* 2. Add requestId as tag */
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
    console.log("OUTBOUND TAG RESPONSE:", updateData);

    if (updateData?.data?.tagsAdd?.userErrors?.length) {
      return res.status(500).json({ error: "Failed to add requestId tag" });
    }

    res.status(200).json({ success: true });

  } catch (err) {
    console.error("Outbound error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* =========================
   INBOUND WEBHOOK (YES CLICK)
   ========================= */
app.post("/msg91/webhook", async (req, res) => {
  try {
    console.log("INBOUND:", JSON.stringify(req.body, null, 2));

    const { requestId } = req.body;
    if (!requestId) {
      return res.status(200).json({ ignored: "requestId missing" });
    }

    let action = "";
    if (req.body.contentType === "button" && req.body.button) {
      const btn = JSON.parse(req.body.button);
      action = btn.payload?.toUpperCase();
    }

    if (action !== "YES") {
      return res.status(200).json({ ignored: "Not YES" });
    }

    const requestTag = buildRequestTag(requestId);

    /* 1. Find order by requestId tag */
    const findOrderQuery = `
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
        body: JSON.stringify({ query: findOrderQuery })
      }
    );

    const orderData = await orderRes.json();
    const order = orderData?.data?.orders?.edges?.[0]?.node;

    if (!order) {
      return res.status(200).json({ ignored: "Order not found for requestId" });
    }

    /* 2. Ensure COD */
    const isCOD = order.paymentGatewayNames.some(gw =>
      gw.toLowerCase().includes("cash")
    );
    if (!isCOD) {
      return res.status(200).json({ ignored: "Not COD order" });
    }

    if (order.tags.includes("COD Confirmed")) {
      return res.status(200).json({ ignored: "Already confirmed" });
    }

    /* 3. Add COD Confirmed (using your known-working logic) */
    const updatedTags = [...order.tags, "COD Confirmed"];

    const updateMutation = `
      mutation {
        orderUpdate(
          input: {
            id: "${order.id}"
            tags: ${JSON.stringify(updatedTags)}
          }
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
        body: JSON.stringify({ query: updateMutation })
      }
    );

    const updateData = await updateRes.json();
    console.log("COD CONFIRM RESPONSE:", updateData);

    res.status(200).json({ success: true });

  } catch (err) {
    console.error("Inbound error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
