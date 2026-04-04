require("dotenv").config();
const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");
const app = express();
const port = process.env.PORT || 3000;
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

// Tracking ID generator
const crypto = require("crypto");
function generateTrackingId() {
  const prefix = "PRCL";
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, ""); // e.g., 20260402
  const random = crypto.randomBytes(3).toString("hex").toUpperCase(); // 6 chars
  return `${prefix}-${date}-${random}`;
}

// Middleware
app.use(cors());
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.w0nmtjl.mongodb.net/?appName=SpeedyParcel`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();

    const database = client.db("speedy_parcel");
    const usersCollection = database.collection("users");
    const parcelsCollection = database.collection("parcels");
    const reviewsCollection = database.collection("reviews");
    const paymentsCollection = database.collection("payments");
    // =============================================================================
    // parcel api
    app.get("/parcels", async (req, res) => {
      const query = {};
      const { email } = req.query;
      if (email) {
        query.senderEmail = email;
      }
      const options = { sort: { createdAt: -1 } };
      const cursor = parcelsCollection.find(query, options);
      const parcels = await cursor.toArray();
      res.send(parcels);
    });

    app.get("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelsCollection.findOne(query);
      res.send(result);
    });

    app.post("/parcels", async (req, res) => {
      const parcel = req.body;
      parcel.createdAt = new Date();
      const result = await parcelsCollection.insertOne(parcel);
      res.send(result);
    });

    app.delete("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelsCollection.deleteOne(query);
      res.send(result);
    });
    // ==============================================================================
    // review api
    app.get("/reviews", async (req, res) => {
      const query = {};
      const { email } = req.query;
      if (email) {
        query.user_email = email;
      }
      const cursor = reviewsCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.post("/reviews", async (req, res) => {
      const review = req.body;
      const result = await reviewsCollection.insertOne(review);
      res.send(result);
    });
    // ============================================================================
    // stripe payment api
    app.post("/stripe-payment", async (req, res) => {
      const paymentInfo = req.body;

      const amount = parseInt(paymentInfo.cost) * 100;

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "USD",
              unit_amount: amount,
              product_data: {
                name: `Please pay for: ${paymentInfo.parcelName}`,
              },
            },
            quantity: 1,
          },
        ],
        customer_email: paymentInfo.senderEmail,
        mode: "payment",
        metadata: {
          parcelId: paymentInfo.parcelId,
          parcelName: paymentInfo.parcelName,
          senderName: paymentInfo.senderName,
          senderAddress: paymentInfo.senderAddress,
        },
        success_url: `${process.env.STRIPE_SITE_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.STRIPE_SITE_DOMAIN}/payment-cancelled`,
      });
      console.log("Stripe session created:", session);
      console.log("Payment Info:", paymentInfo);
      res.send({ url: session.url });
    });
    // ===============================================================================
    // payment check api
    app.patch("/payment-check", async (req, res) => {
      const sessionId = req.query.session_id;
      console.log(
        "Received payment success request for session ID:",
        sessionId,
      );
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      console.log("Retrieved Stripe session:", session);

      const transactionId = session.payment_intent;
      const query = { transactionId: transactionId };
      const existingPayment = await paymentsCollection.findOne(query);

      if (existingPayment) {
        console.log("Payment already recorded in database:", existingPayment);
        return res.send({
          success: true,
          message: "Payment already processed",
          transactionId,
          trackingId: existingPayment.trackingId,
        });
      }

      const trackingId = generateTrackingId();

      if (session.payment_status === "paid") {
        const id = session.metadata.parcelId;
        const query = { _id: new ObjectId(id) };
        const update = {
          $set: {
            paymentStatus: "paid",
            trackingId: trackingId,
          },
        };
        const result = await parcelsCollection.updateOne(query, update);
        console.log("Updated parcel payment status in database:", result);

        const payment = {
          senderName: session.metadata.senderName,
          senderAddress: session.metadata.senderAddress,
          customerEmail: session.customer_email,
          parcelName: session.metadata.parcelName,
          amount: session.amount_total / 100,
          currency: session.currency,
          parcelId: session.metadata.parcelId,
          transactionId: session.payment_intent,
          paymentStatus: session.payment_status,
          paidDate: new Date(),
          trackingId: trackingId,
        };

        // const resultPayment = await paymentsCollection.insertOne(payment);
        if (session.payment_status === "paid") {
          const resultPayment = await paymentsCollection.insertOne(payment);
          res.send({
            success: true,
            modifyParcel: result,
            trackingId: trackingId,
            transactionId: session.payment_intent,
            paymentInfo: resultPayment,
            parcelName: session.metadata.parcelName,
          });
        }
        // res.send(resultPayment)
      }
      // res.send({success: false });
    });

    app.get("/payment-history", async (req, res) => {
      const email = req.query.email;
      const query = {};
      if (email) {
        query.customerEmail = email;
      }

      const cursor = paymentsCollection.find(query).sort({ paidDate: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });

    //=============================================================================

    const otpStore = {};
    // nodemailer ==========
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL, // তোমার gmail
        pass: process.env.EMAIL_PASS, // gmail app password
      },
    });

    // Send OTP
    app.post("/send-otp", async (req, res) => {
      const { email } = req.body;

      if (!email) return res.status(400).send({ message: "Email is required" });

      const otp = Math.floor(100000 + Math.random() * 900000); // 6-digit
      otpStore[email] = {
        code: otp,
        expire: Date.now() + 5 * 60 * 1000, // 5 min
      };

      try {
        await transporter.sendMail({
          from: process.env.EMAIL,
          to: email,
          subject: "Your OTP Code",
          html: `<h2>Your OTP Code</h2><h1>${otp}</h1><p>This code will expire in 5 minutes</p>`,
        });

        console.log("OTP sent to:", email, otp); // debug
        res.send({ success: true, message: "OTP sent" });
      } catch (err) {
        console.log(err);
        res.status(500).send({ message: "Failed to send OTP" });
      }
    });

    // Verify OTP
    app.post("/verify-otp", (req, res) => {
      const { email, otp } = req.body;
      const stored = otpStore[email];

      if (!stored) return res.status(400).send({ message: "No OTP found" });
      if (stored.expire < Date.now())
        return res.status(400).send({ message: "OTP expired" });
      if (stored.code !== Number(otp))
        return res.status(400).send({ message: "Invalid OTP" });

      delete otpStore[email];
      res.send({ success: true, message: "OTP Verified" });
    });

    //=============================================================================

    // Ping!
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Speedy-Parcel app is running!");
});

app.listen(port, () => {
  console.log(`Speedy-Parcel app listening on port ${port}`);
});
