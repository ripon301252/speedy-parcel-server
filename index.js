require("dotenv").config();
const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");
const app = express();
const port = process.env.PORT || 3000;
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

// fire-base admin
const admin = require("firebase-admin");
const serviceAccount = require("./speedy-parcel-firebase-adminsdk.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// Tracking ID generator
const crypto = require("crypto");
const { create } = require("domain");
function generateTrackingId() {
  const prefix = "PRCL";
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, ""); // e.g., 20260402
  const random = crypto.randomBytes(3).toString("hex").toUpperCase(); // 6 chars
  return `${prefix}-${date}-${random}`;
}

// Middleware
app.use(cors());
app.use(express.json());

const verifyFBToken = async (req, res, next) => {
  // console.log("headers in the middleware", req.headers.authorization);
  const tokenFB = req.headers.authorization;
  if (!tokenFB) {
    return res.status(401).send({ massage: "do not your token FB" });
  }

  try {
    const idToken = tokenFB.split(" ")[1];
    // console.log('verifyToken', idToken)
    const decoded = await admin.auth().verifyIdToken(idToken);
    // console.log("decoded in the token", decoded)
    req.decoded_email = decoded.email;
  } catch (err) {
    return res.status(401).send({ message: "unauthorized access" });
  }

  next();
};

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
    const ridersCollection = database.collection("riders");
    const trackingsCollection = database.collection("trackings");

    // middle admin before allowing admin activity
    // must be used after verifyFBToken middleware
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email };
      const user = await usersCollection.findOne(query);

      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "forbidden access" });
      }

      next();
    };

    // verify rider
    const verifyRider = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email };
      const user = await usersCollection.findOne(query);

      if (!user || user.role !== "rider") {
        return res.status(403).send({ message: "forbidden access" });
      }

      next();
    };

    // verify role
    // const verifyRole = (role) => {
    //   return async (req, res, next) => {
    //     const email = req.decoded_email;
    //     const user = await usersCollection.findOne({ email });

    //     if (!user || user.role !== role) {
    //       return res.status(403).send({ message: "forbidden access" });
    //     }

    //     next();
    //   };
    // };

    const logTracking = async (trackingId, status) => {
      const log = {
        trackingId,
        status,
        details: status.split("_").join(" "),
        createdAt: new Date(),
      };
      const result = await trackingsCollection.insertOne(log);
      return result;
    };

    // ============================================================================
    // users related apis
    app.get("/users", verifyFBToken, async (req, res) => {
      const { searchText, email, role } = req.query;

      let query = {};

      if (email) {
        query.email = email;
      }

      if (searchText) {
        query = {
          $or: [
            { name: { $regex: searchText, $options: "i" } },
            { email: { $regex: searchText, $options: "i" } },
          ],
        };
      }

      if (role) {
        query.role = role;
      }

      const options = { sort: { createdAt: -1 } };

      const result = await usersCollection
        .find(query, options)
        .limit(10)
        .toArray();

      res.send(result);
    });

    // app.get("/users/:id", async (req, res) => {});

    app.get("/users/:email/role", async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      res.send({ role: user?.role || "user" });
    });

    app.post("/users", async (req, res) => {
      const user = req.body;
      user.role = "user";
      user.createdAt = new Date();

      const email = user.email;
      const existingUser = await usersCollection.findOne({ email });
      if (existingUser) {
        return res.send({ message: "User already exists" });
      }

      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    app.patch(
      "/users/:id/role",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const roleInfo = req.body;
        const query = { _id: new ObjectId(id) };
        const updateDoc = {
          $set: {
            role: roleInfo.role,
          },
        };
        const result = await usersCollection.updateOne(query, updateDoc);
        res.send(result);
      },
    );

    app.delete("/users/:id", verifyFBToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await usersCollection.deleteOne(query);
      res.send(result);
    });

    // =============================================================================
    // parcel api
    app.get("/parcels", async (req, res) => {
      const query = {};

      const { email, deliveryStatus } = req.query;

      if (email) {
        query.senderEmail = email;
      }

      if (deliveryStatus) {
        query.deliveryStatus = deliveryStatus;
      }

      const options = { sort: { createdAt: -1 } };
      const cursor = parcelsCollection.find(query, options);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get("/parcels/rider", verifyFBToken, verifyRider, async (req, res) => {
      const { riderEmail, deliveryStatus } = req.query;
      const query = {};

      if (riderEmail) {
        query.riderEmail = riderEmail;
      }

      // if (deliveryStatus) {
      //   // query.deliveryStatus = {$in: ['driver_assigned', "rider_accepted"]}
      //   query.deliveryStatus = { $nin: ["parcel_delivered", "rider_rejected"] };
      // }

      if (deliveryStatus !== "parcel_delivered") {
        // query.deliveryStatus = {$in: ['driver_assigned', "rider_accepted"]}
        query.deliveryStatus = { $nin: ["parcel_delivered", "rider_rejected"] };
      } else {
        query.deliveryStatus = deliveryStatus;
      }

      const cursor = parcelsCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelsCollection.findOne(query);
      res.send(result);
    });

    app.post("/parcels", async (req, res) => {
      const parcel = req.body;
      const trackingId = generateTrackingId(); // new

      parcel.createdAt = new Date();
      parcel.trackingId = trackingId; // new
      logTracking(trackingId, "parcel_created"); // new

      const result = await parcelsCollection.insertOne(parcel);
      res.send(result);
    });

    // TODO: rename this to be specific like /parcels/:id/assign
    app.patch("/parcels/:id", async (req, res) => {
      const { riderId, riderName, riderEmail, trackingId, parcelId } = req.body;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };

      const updateDoc = {
        $set: {
          deliveryStatus: "driver_assigned",
          riderId: riderId,
          riderName: riderName,
          riderEmail: riderEmail,
        },
      };

      const result = await parcelsCollection.updateOne(query, updateDoc);

      // update rider information
      const riderQuery = { _id: new ObjectId(riderId) };
      const riderUpdatedDoc = {
        $set: {
          workStatus: "in_delivery",
        },
      };
      const riderResult = await ridersCollection.updateOne(
        riderQuery,
        riderUpdatedDoc,
      );

      // logTracking
      logTracking(trackingId, "driver_assigned");

      res.send(riderResult);
    });

    app.patch(
      "/parcels/:id/deliveryStatus",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        const { deliveryStatus, riderId, trackingId } = req.body;
        const query = { _id: new ObjectId(req.params.id) };
        const updatedDoc = {
          $set: {
            deliveryStatus: deliveryStatus,
          },
        };

        if (deliveryStatus === "parcel_delivered") {
          // update rider information
          const riderQuery = { _id: new ObjectId(riderId) };
          const riderUpdatedDoc = {
            $set: {
              workStatus: "available",
            },
          };
          const riderResult = await ridersCollection.updateOne(
            riderQuery,
            riderUpdatedDoc,
          );
        }

        const result = await parcelsCollection.updateOne(query, updatedDoc);
        // logTracking
        logTracking(trackingId, deliveryStatus);

        res.send(result);
      },
    );

    app.delete("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelsCollection.deleteOne(query);
      res.send(result);
    });
    // ==============================================================================
    // riders api
    app.get("/riders", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const {
          email,
          status,
          searchText,
          riderDistrict,
          riderArea,
          workStatus,
        } = req.query;

        let query = {};

        // Email filter
        if (email && email !== "") {
          query.riderEmail = email;
        }

        // Status filter (IMPORTANT FIX)
        if (status && status !== "") {
          if (status === "pending") {
            // pending = no status OR pending
            query.$or = [{ status: { $exists: false } }, { status: "pending" }];
          } else {
            query.status = status;
          }
        }

        // Search filter (merge safely)
        if (searchText && searchText !== "") {
          const searchQuery = {
            $or: [
              { riderName: { $regex: searchText, $options: "i" } },
              { riderEmail: { $regex: searchText, $options: "i" } },
            ],
          };

          // merge with existing query
          query = {
            $and: [query, searchQuery],
          };
        }

        if (riderDistrict) {
          query.riderDistrict = { $regex: riderDistrict, $options: "i" };
        }

        if (riderArea) {
          query.riderArea = { $regex: riderArea, $options: "i" };
        }

        if (workStatus) {
          query.workStatus = { $regex: workStatus, $options: "i" };
        }

        const options = {
          sort: { createdAt: -1 },
        };

        const result = await ridersCollection
          .find(query, options)
          .limit(10)
          .toArray();

        res.send(result);
      } catch (error) {
        console.log(error);
        res.status(500).send({ message: "Server error" });
      }
    });

    app.post("/riders", async (req, res) => {
      const rider = req.body;
      rider.status = "pending";
      rider.createdAt = new Date();

      const email = rider.riderEmail;
      const existingRider = await ridersCollection.findOne({
        riderEmail: email,
      });
      if (existingRider) {
        return res.send({ message: "User already exists" });
      }

      const result = await ridersCollection.insertOne(rider);
      res.send(result);
    });

    // app.post("/riders", async (req, res) => {
    //   try {
    //     const rider = req.body;
    //     rider.status = "pending";
    //     rider.createdAt = new Date();

    //     const email = rider.riderEmail;

    //     // 🔥 check in ridersCollection (not usersCollection)
    //     const existingRider = await ridersCollection.findOne({
    //       riderEmail: email,
    //     });

    //     if (existingRider) {
    //       return res.send({ message: "Rider already applied" });
    //     }

    //     const result = await ridersCollection.insertOne(rider);
    //     res.send(result);
    //   } catch (error) {
    //     console.error(error);
    //     res.status(500).send({ error: "Something went wrong" });
    //   }
    // });

    app.patch("/riders/:id", verifyFBToken, verifyAdmin, async (req, res) => {
      const status = req.body.status;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          status: status,
          workStatus: "available",
        },
      };
      const result = await ridersCollection.updateOne(query, updateDoc);

      if (status === "approved") {
        const email = req.body.email;
        const userQuery = { email };
        const updateUser = {
          $set: {
            role: "rider",
          },
        };
        const userResult = await usersCollection.updateOne(
          userQuery,
          updateUser,
        );
      }

      if (status === "rejected") {
        const email = req.body.email;
        const userQuery = { email };
        const updateUser = {
          $set: {
            role: "user",
          },
        };
        const userResult = await usersCollection.updateOne(
          userQuery,
          updateUser,
        );
      }
      res.send(result);
    });

    // app.patch("/riders/:id", verifyFBToken, verifyAdmin, async (req, res) => {
    //   try {
    //     const status = req.body.status;
    //     const id = req.params.id;

    //     const query = { _id: new ObjectId(id) };
    //     const updateDoc = {
    //       $set: {
    //          status: status,
    //          workStatus: 'available'
    //        }

    //     };

    //     const result = await ridersCollection.updateOne(query, updateDoc);

    //     // role determine
    //     let role = null;
    //     if (status === "approved") role = "rider";
    //     if (status === "rejected") role = "user";

    //     let userResult = null;

    //     // update user role (single জায়গায়)
    //     if (role) {
    //       userResult = await usersCollection.updateOne(
    //         { email: req.body.email },
    //         { $set: { role } },
    //       );
    //     }

    //     res.send(result);
    //   } catch (error) {
    //     console.error(error);
    //     res.status(500).send({ error: "Something went wrong" });
    //   }
    // });

    app.delete("/riders/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await ridersCollection.deleteOne(query);
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
    app.post("/stripe-payment", verifyFBToken, async (req, res) => {
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
          senderPhoto: paymentInfo.senderPhoto,
          trackingId: paymentInfo.trackingId, // new
        },
        customer_email: paymentInfo.senderEmail, // new me

        success_url: `${process.env.STRIPE_SITE_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.STRIPE_SITE_DOMAIN}/payment-cancelled`,
      });
      console.log("Stripe session created:", session);
      console.log("Payment Info:", paymentInfo);
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

      const transactionId = session.payment_intent;
      const query = { transactionId: transactionId };
      const existingPayment = await paymentsCollection.findOne(query);

      if (existingPayment) {
        console.log("Payment already recorded in database:", existingPayment);
        return res.send({
          // success: true,
          message: "Payment already processed",
          transactionId,
          trackingId: existingPayment.trackingId,
        });
      }

      // const trackingId = generateTrackingId(); // old
      const trackingId = session.metadata.trackingId; // new

      if (session.payment_status === "paid") {
        const id = session.metadata.parcelId;
        const query = { _id: new ObjectId(id) };
        const update = {
          $set: {
            paymentStatus: "paid",
            deliveryStatus: "pending-pickup",
            // trackingId: trackingId,   // old
          },
        };
        const result = await parcelsCollection.updateOne(query, update);
        console.log("Updated parcel payment status in database:", result);

        const payment = {
          senderName: session.metadata.senderName,
          senderAddress: session.metadata.senderAddress,
          senderPhoto: session.metadata.senderPhoto,
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

        const resultPayment = await paymentsCollection.insertOne(payment);

        if (session.payment_status === "paid") {
          // const resultPayment = await paymentsCollection.insertOne(payment);
          logTracking(trackingId, "pending-pickup");

          return res.send({
            success: true,
            modifyParcel: result,
            trackingId: trackingId,
            transactionId: session.payment_intent,
            paymentInfo: resultPayment,
            parcelName: session.metadata.parcelName,
          });
        }
      }
      return res.send({ success: false });
    });

    app.get("/payment-history", verifyFBToken, async (req, res) => {
      const email = req.query.email;
      const query = {};

      console.log("headers", req.headers);

      if (email) {
        query.customerEmail = email;

        if (email !== req.decoded_email) {
          return res.status(403).send({ message: "forbidden access" });
        }
      }

      const cursor = paymentsCollection.find(query).sort({ paidDate: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });

    app.delete("/payment-history/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await paymentsCollection.deleteOne(query);
      res.send(result);
    });

    //=============================================================================
    // OTP related apis
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
    // tracking related api
    app.get("/trackings/:trackingId/logs", async (req, res) => {
      const trackingId = req.params.trackingId;
      const query = { trackingId };
      const cursor = await trackingsCollection.find(query).toArray();
      res.send(cursor);
    });
    //=============================================================================

    // cash out related api

    app.get("/cash-outs", async (req, res) => {
      const result = await database
        .collection("cash-outs")
        .find()
        .sort({ createdAt: -1 }) // ✅ newest first
        .toArray();

      res.send(result);
    });

    app.post("/cash-out", async (req, res) => {
      try {
        const { riderEmail, parcelId, amount } = req.body;

        const existing = await database
          .collection("cash-outs")
          .findOne({ parcelId });

        if (existing) {
          return res.status(400).send({ message: "Already cashed out" });
        }

        const cash_out = {
          riderEmail,
          parcelId,
          amount,
          status: "pending",
          createdAt: new Date(),
        };

        const result = await database
          .collection("cash-outs")
          .insertOne(cash_out);

        res.send(result);
      } catch (error) {
        console.log("Cash-out Error:", error);
        res.status(500).send({ message: "Cash-out failed" });
      }
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
