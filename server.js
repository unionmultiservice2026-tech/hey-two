import express from "express";
import Stripe from "stripe";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "");
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

/*
 Demo account store only.
 Replace with your real authentication and database before production.
*/
const users = new Map();

function getUser(req) {
  const id = req.get("x-demo-user-id") || "demo-user";
  if (!users.has(id)) {
    users.set(id, {
      id,
      gender: "Man",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      premiumActive: false
    });
  }
  return users.get(id);
}

/* Stripe requires the raw request body for webhook signature verification. */
app.post("/api/stripe-webhook", express.raw({type:"application/json"}), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const userId = session.metadata?.userId;
      if (userId && users.has(userId)) {
        const user = users.get(userId);
        user.stripeCustomerId = typeof session.customer === "string" ? session.customer : null;
        user.stripeSubscriptionId = typeof session.subscription === "string" ? session.subscription : null;
        user.premiumActive = true;
      }
    }

    if (event.type === "customer.subscription.updated" ||
        event.type === "customer.subscription.deleted") {
      const sub = event.data.object;
      for (const user of users.values()) {
        if (user.stripeSubscriptionId === sub.id) {
          user.premiumActive = ["active","trialing"].includes(sub.status);
        }
      }
    }

    res.json({received:true});
  } catch (err) {
    console.error(err);
    res.status(500).json({error:"Webhook processing failed."});
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const user = getUser(req);

    if (user.gender === "Woman") {
      return res.status(400).json({error:"Women already have full access for free."});
    }

    if (!process.env.STRIPE_PRICE_ID) {
      return res.status(500).json({error:"STRIPE_PRICE_ID is not configured."});
    }

    const params = {
      mode: "subscription",
      line_items: [{price:process.env.STRIPE_PRICE_ID, quantity:1}],
      success_url: `${APP_URL}/?checkout=success`,
      cancel_url: `${APP_URL}/?checkout=cancelled`,
      metadata: {userId:user.id},
      subscription_data: {metadata:{userId:user.id}}
    };

    if (user.stripeCustomerId) params.customer = user.stripeCustomerId;

    const session = await stripe.checkout.sessions.create(params);
    res.json({url:session.url});
  } catch (err) {
    console.error(err);
    res.status(500).json({error:err.message || "Unable to create checkout session."});
  }
});

app.get("/api/subscription-status", async (req, res) => {
  try {
    const user = getUser(req);

    if (user.gender === "Woman") {
      return res.json({active:true, access:"free-full-access"});
    }

    if (!user.stripeSubscriptionId) {
      return res.json({active:false, access:"free-browse"});
    }

    const sub = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
    const active = ["active","trialing"].includes(sub.status);
    user.premiumActive = active;

    res.json({
      active,
      access: active ? "premium" : "free-browse",
      status: sub.status
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({error:"Unable to verify subscription status."});
  }
});

/* Example server-side enforcement for private messaging. */
app.post("/api/messages", (req, res) => {
  const user = getUser(req);

  if (user.gender !== "Woman" && !user.premiumActive) {
    return res.status(403).json({
      error:"An active Premium subscription is required to send private messages."
    });
  }

  res.json({ok:true});
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Hey Two running at ${APP_URL}`);
});
