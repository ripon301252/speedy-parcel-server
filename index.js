require('dotenv').config()
const express = require('express');
const cors = require('cors');
const app = express();
const port = process.env.PORT || 3000;
const { MongoClient, ServerApiVersion } = require('mongodb');

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
  }
});


async function run() {
  try {
    await client.connect();

    const database = client.db("speedy_parcel");
    const usersCollection = database.collection("users");
    const parcelsCollection = database.collection("parcels");
    const reviewsCollection = database.collection("reviews");


    // parcel api
    app.get('/parcels', async (req, res) => {
      const query = {};  
      const {email} = req.query;
      if(email){
        query.senderEmail = email;
      }
      const cursor = parcelsCollection.find(query);
      const parcels = await cursor.toArray();
      res.send(parcels);
    });


    app.post('/parcels', async (req, res) => {
      const parcel = req.body;
      const result = await parcelsCollection.insertOne(parcel);
      res.send(result);
    });

    // review api
    app.get('/reviews', async (req, res) => {
      const query = {};
      const {email} = req.query;
      if(email){
        query.user_email = email;
      }
      const cursor = reviewsCollection.find(query);
      const reviews = await cursor.toArray();
      res.send(reviews);
    });

    app.post('/reviews', async (req, res) => {
      const review = req.body;
      const result = await reviewsCollection.insertOne(review);
      res.send(result);
    });





    // Ping!
    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } 
  finally {
    
    
  }
}
run().catch(console.dir);






app.get('/', (req, res) => {
  res.send('Speedy-Parcel app is running!')
})

app.listen(port, () => {
  console.log(`Speedy-Parcel app listening on port ${port}`)
})



