require("dotenv").config();
const express = require("express");
const cors = require("cors");
const app = express();
const port = process.env.PORT || 3000;
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

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
        },
        success_url: `${process.env.STRIPE_SITE_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.STRIPE_SITE_DOMAIN}/payment-cancelled`,
      });
      console.log("Stripe session created:", session);
      res.send({ url: session.url });
    });

    // payment check api
    app.patch("/payment-check", async (req, res) => {
      const sessionId = req.query.session_id;
      console.log(
        "Received payment success request for session ID:",
        sessionId,
      );
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      console.log("Retrieved Stripe session:", session);

        if (session.payment_status === "paid") {
          const id = session.metadata.parcelId;
          const query = { _id: new ObjectId(id) };
          const updateDoc = {
            $set: {
              paymentStatus: "paid",
            },
          }
          const result = await parcelsCollection.updateOne(query, updateDoc);
          console.log("Updated parcel payment status in database:", result);
           res.send(result);
        }

      res.send({ success: false});
    });

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
