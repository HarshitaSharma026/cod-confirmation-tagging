const express = require('express');
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.urlencoded({extended: false}));
const SHOP = process.env.SHOP;
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;

app.use(express.json());

/* Health check */
app.get("/", (req, res) => {
  res.send("COD Confirmation Server Running");
});

/* FOR OUTBOUND REQUEST AND REQUESTID TAGGING */
app.post("/msg91/outbound", async (req, res) => {
  try {
    console.log("MSG91 OUTBOUND Payload:", JSON.stringify(req.body, null, 2));

    const requestId = req.body.requestId;
    const customerNumber = req.body.customerNumber; // 918XXXXXXXXX

    if (!requestId || !customerNumber) {
      return res.status(200).json({ ignored: "Missing requestId or customerNumber" });
    }

    // Normalize phone (last 10 digits)
    const phone = customerNumber.slice(-10);

    /* 1. Find latest COD order by phone */
    const findOrderQuery = `
      query {
        orders(
          first: 1,
          sortKey: CREATED_AT,
          reverse: true,
          query: "payment_gateway:Cash"
        ) {
          edges {
            node {
              id
              name
            }
          }
        }
      }
    `;


    const orderRes = await fetch(
      `https://${SHOP}/admin/api/2026-01/graphql.json`,
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
      console.warn("No COD order found for phone:", phone);
      return res.status(200).json({ ignored: "Order not found" });
    }

    /* 2. Save requestId to Shopify metafield */
    const metafieldMutation = `
      mutation {
        metafieldsSet(metafields: [{
          namespace: "msg91"
          key: "request_id"
          type: "single_line_text_field"
          value: "${requestId}"
          ownerId: "${order.id}"
        }]) {
          metafields {
            id
            key
            value
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const mfRes = await fetch(
      `https://${SHOP}/admin/api/2026-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": SHOPIFY_TOKEN
        },
        body: JSON.stringify({ query: metafieldMutation })
      }
    );

    const mfData = await mfRes.json();
    console.log("Metafield saved:", mfData);

    res.status(200).json({
      success: true,
      order: order.name,
      requestId
    });

  } catch (err) {
    console.error("Outbound webhook error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* MSG91 WEBHOOK -> inbound */
app.post("/msg91/webhook", async (req, res) => {
  try {
    console.log("MSG91 INBOUND Payload:", JSON.stringify(req.body, null, 2));

    const requestId = req.body.requestId;
    if (!requestId) {
      return res.status(200).json({ ignored: "requestId missing" });
    }

    let action = "";
    console.log("body:", req.body);
    if (req.body.contentType === "button" && req.body.button) {
      try {
        const btn = JSON.parse(req.body.button);
        action = btn.payload?.toUpperCase();
      } catch (e) {
        console.error("Button parse failed");
      }
    }

    if (action !== "YES") {
      return res.status(200).json({ ignored: "Not YES" });
    }

    /* Find order via metafield */
    const findOrderQuery = `
      query {
        orders(first: 1, query: "metafield:msg91.request_id=${requestId}") {
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
      `https://${SHOP}/admin/api/2026-01/graphql.json`,
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

    const isCOD = order.paymentGatewayNames.some(gw =>
      gw.toLowerCase().includes("cash")
    );

    if (!isCOD) {
      return res.status(200).json({ ignored: "Not COD order" });
    }

    const existingTags = Array.isArray(order.tags) ? order.tags : [];

    if (existingTags.includes("COD Confirmed")) {
      return res.status(200).json({ ignored: "Already confirmed" });
    }

    const updatedTags = [...existingTags, "COD Confirmed"];

    const updateMutation = `
      mutation {
        orderUpdate(input: {
          id: "${order.id}"
          tags: ${JSON.stringify(updatedTags)}
        }) {
          order { id tags }
          userErrors { message }
        }
      }
    `;

    await fetch(
      `https://${SHOP}/admin/api/2026-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": SHOPIFY_TOKEN
        },
        body: JSON.stringify({ query: updateMutation })
      }
    );

    res.status(200).json({ success: true });

  } catch (err) {
    console.error("Inbound error:", err);
    res.status(200).json({ error: "Handled" });
  }
});


app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
