const express = require('express');
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));


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

/* MSG91 WEBHOOK */
app.post("/msg91/webhook", async (req, res) => {
  try {
    console.log("MSG91 Payload:", JSON.stringify(req.body, null, 2));

    const text = (req.body.text || "").trim().toUpperCase();
    const orderNumber = (req.body.orders || "").replace("#", "").trim();

    if (text !== "YES") {
      return res.status(200).json({ ignored: "Not YES" });
    }

    if (!orderNumber) {
      return res.status(400).json({ error: "Order number missing" });
    }

    /* 1. Find order by order name */
    const findOrderQuery = `
      query {
        orders(first: 1, query: "name:#${orderNumber}") {
          edges {
            node {
              id
              tags
              paymentGatewayNames
              displayFinancialStatus
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
    // console.log(orderData);
    // console.log(orderRes);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    /* 2. Ensure COD order */
    const isCOD = order.paymentGatewayNames.some(gw =>
      gw.toLowerCase().includes("cash")
    );

    if (!isCOD) {
      return res.status(200).json({ ignored: "Not COD order" });
    }

    /* 3. Avoid duplicate tag */
    if (order.tags.includes("COD Confirmed")) {
      return res.status(200).json({ ignored: "Already confirmed" });
    }

    /* 4. Add COD Confirmed tag */
    const updatedTags = [...order.tags, "COD Confirmed"];

    const updateMutation = `
      mutation {
        orderUpdate(
          input: {
            id: "${order.id}"
            tags: ${JSON.stringify(updatedTags)}
          }
        ) {
          order {
            id
            tags
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const updateRes = await fetch(
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

    const updateData = await updateRes.json();

    console.log("COD Confirmed Tag Added:", updateData);

    res.status(200).json({ success: true });
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
