const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion } = require('mongodb');
require('dotenv').config();

const app = express();
const port = process.env.PORT;

app.use(cors());
app.use(express.json());

// ─── MongoDB Connection ───────────────────────────────────────────────────────
const uri = process.env.MONGO_URI;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let db;

async function connectDB() {
  await client.connect();
  await client.db('admin').command({ ping: 1 });
  console.log('✅ Pinged your deployment. Successfully connected to MongoDB!');
  db = client.db('auragym');
}

// Start DB connection — server listens only after DB is ready
connectDB()
  .then(() => {
    app.listen(port, () => {
      console.log(`🚀 AuraGym server running on http://localhost:${port}`);
    });
  })
  .catch((err) => {
    console.error('❌ Failed to connect to MongoDB:', err);
    process.exit(1);
  });

// ─── Root Health Check ───────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ message: 'AuraGym Server Running 🏋️', status: 'ok' });
});

// ─── GET Featured Classes (top 6 by booking count) ──────────────────────────
app.get('/api/featured-classes', async (req, res) => {
  try {
    const classes = await db
      .collection('classes')
      .find({})
      .sort({ bookingCount: -1 })
      .limit(6)
      .toArray();
    res.json(classes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET All Classes with Search, Filter & Pagination (MongoDB $regex / $in) ─
app.get('/api/classes', async (req, res) => {
  try {
    const { search, category, page = 1, limit = 6 } = req.query;

    // Build dynamic query object
    const query = {};

    // 1. Search by Class Name — MongoDB $regex (case-insensitive)
    if (search && search.trim() !== '') {
      query.className = { $regex: search.trim(), $options: 'i' };
    }

    // 2. Filter by Category — MongoDB $in (supports comma-separated values)
    if (category && category.trim() !== '') {
      const categoryArray = Array.isArray(category)
        ? category
        : category.split(',').map((c) => c.trim()).filter(Boolean);
      if (categoryArray.length > 0) {
        query.category = { $in: categoryArray };
      }
    }

    // 3. Server-side Pagination
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    const classesCol = db.collection('classes');

    // Total matching count for pagination metadata
    const totalClasses = await classesCol.countDocuments(query);

    // Fetch paginated, filtered results
    const classes = await classesCol
      .find(query)
      .skip(skip)
      .limit(limitNum)
      .toArray();

    res.json({
      classes,
      totalClasses,
      totalPages: Math.ceil(totalClasses / limitNum),
      currentPage: pageNum,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET Latest 4 Forum Posts ────────────────────────────────────────────────
app.get('/api/forum/latest', async (req, res) => {
  try {
    const posts = await db
      .collection('forumPosts')
      .find({})
      .sort({ createdAt: -1 })
      .limit(4)
      .toArray();
    res.json(posts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET All Forum Posts with Server-side Pagination ─────────────────────────
app.get('/api/forum', async (req, res) => {
  try {
    const { page = 1, limit = 5 } = req.query;

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    const forumCol = db.collection('forumPosts');
    const totalPosts = await forumCol.countDocuments({});

    const posts = await forumCol
      .find({})
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .toArray();

    res.json({
      posts,
      totalPosts,
      totalPages: Math.ceil(totalPosts / limitNum),
      currentPage: pageNum,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});