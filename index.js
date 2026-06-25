const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
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

// ─── GET Single Class by ID ──────────────────────────────────────────────────
app.get('/api/classes/:id', async (req, res) => {
  try {
    const classId = req.params.id;
    if (!ObjectId.isValid(classId)) {
      return res.status(400).json({ error: 'Invalid Class ID' });
    }
    const classDetails = await db.collection('classes').findOne({ _id: new ObjectId(classId) });
    if (!classDetails) {
      return res.status(404).json({ error: 'Class not found' });
    }
    res.json(classDetails);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET Booking Check ───────────────────────────────────────────────────────
app.get('/api/bookings/check', async (req, res) => {
  try {
    const { classId, userId } = req.query;
    if (!classId || !userId) {
      return res.status(400).json({ error: 'Missing classId or userId' });
    }

    const booking = await db.collection('bookings').findOne({ classId, userId });
    res.json({ isBooked: !!booking });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET User Bookings (with class details) ──────────────────────────────────
app.get('/api/users/:userId/bookings', async (req, res) => {
  try {
    const { userId } = req.params;

    // The db schema sometimes uses email as userId or string, handle normally
    const bookings = await db.collection('bookings')
      .find({ userId })
      .sort({ createdAt: -1 })
      .toArray();

    // Extract classIds and fetch classes
    const classIds = bookings
      .filter(b => b.classId && ObjectId.isValid(b.classId))
      .map(b => new ObjectId(b.classId));

    const classes = await db.collection('classes')
      .find({ _id: { $in: classIds } })
      .toArray();

    // Merge
    const result = bookings.map(b => {
      const cls = classes.find(c => c._id.toString() === b.classId);
      return { ...b, classDetails: cls || null };
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET User Favorites (with class details) ──────────────────────────────────
app.get('/api/users/:userId/favorites', async (req, res) => {
  try {
    const { userId } = req.params;

    const favorites = await db.collection('favorites')
      .find({ userId })
      .sort({ createdAt: -1 })
      .toArray();

    const classIds = favorites
      .filter(f => f.classId && ObjectId.isValid(f.classId))
      .map(f => new ObjectId(f.classId));

    const classes = await db.collection('classes')
      .find({ _id: { $in: classIds } })
      .toArray();

    const result = favorites.map(f => {
      const cls = classes.find(c => c._id.toString() === f.classId);
      return { ...f, classDetails: cls || null };
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET Favorite Check ──────────────────────────────────────────────────────
app.get('/api/favorites/check', async (req, res) => {
  try {
    const { classId, userId } = req.query;
    if (!classId || !userId) {
      return res.status(400).json({ error: 'Missing classId or userId' });
    }

    const favorite = await db.collection('favorites').findOne({ classId, userId });
    res.json({ isFavorited: !!favorite });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST Toggle Favorite ────────────────────────────────────────────────────
app.post('/api/favorites/toggle', async (req, res) => {
  try {
    const { classId, userId } = req.body;
    if (!classId || !userId) {
      return res.status(400).json({ error: 'Missing classId or userId' });
    }

    const favoritesCol = db.collection('favorites');
    const existing = await favoritesCol.findOne({ classId, userId });

    if (existing) {
      // Remove favorite
      await favoritesCol.deleteOne({ _id: existing._id });
      res.json({ isFavorited: false, message: 'Removed from favorites' });
    } else {
      // Add favorite
      await favoritesCol.insertOne({ classId, userId, createdAt: new Date() });
      res.json({ isFavorited: true, message: 'Added to favorites' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST Apply as Trainer ───────────────────────────────────────────────────
app.post('/api/trainer-apply', async (req, res) => {
  try {
    const { name, email, experience, specialty, bio } = req.body;
    if (!email || !experience || !specialty) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const col = db.collection('trainerApplications');

    // Check if already applied
    const existing = await col.findOne({ email });
    if (existing) {
      if (existing.status === 'Rejected') {
        const timeDiff = new Date() - new Date(existing.updatedAt || existing.createdAt);
        const min30 = 2 * 60 * 1000;

        if (timeDiff < min30) {
          const timeLeft = Math.ceil((min30 - timeDiff) / 60000);
          return res.status(409).json({
            error: `You can re-apply after ${timeLeft} minutes.`,
            status: existing.status,
            canReapply: false,
            timeLeft
          });
        } else {
          // 30 mins passed, delete old application so they can apply again
          await col.deleteOne({ _id: existing._id });
        }
      } else {
        return res.status(409).json({ error: 'You have already submitted an application.', status: existing.status });
      }
    }

    const result = await col.insertOne({
      name,
      email,
      experience: Number(experience),
      specialty,
      bio: bio || '',
      status: 'Pending',
      feedback: null,
      createdAt: new Date(),
    });

    res.status(201).json({ message: 'Application submitted successfully!', id: result.insertedId, status: 'Pending' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET Trainer Application by Email ────────────────────────────────────────
app.get('/api/trainer-apply/:email', async (req, res) => {
  try {
    const { email } = req.params;
    const application = await db.collection('trainerApplications').findOne({ email });
    if (!application) {
      return res.status(404).json({ exists: false });
    }

    let canReapply = false;
    let timeLeft = 0;
    if (application.status === 'Rejected') {
      const timeDiff = new Date() - new Date(application.updatedAt || application.createdAt);
      const min30 = 30 * 60 * 1000;
      if (timeDiff >= min30) {
        canReapply = true;
      } else {
        timeLeft = Math.ceil((min30 - timeDiff) / 60000);
      }
    }

    res.json({
      exists: true,
      status: application.status,
      feedback: application.feedback,
      specialty: application.specialty,
      experience: application.experience,
      canReapply,
      timeLeft
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET User Dashboard Stats ────────────────────────────────────────────────
app.get('/api/users/:email/stats', async (req, res) => {
  try {
    const { email } = req.params;

    // In this app, sometimes userId is stored as email in bookings/favorites, 
    // or we might need to find the user first. We will check both.
    const user = await db.collection('user').findOne({ email });
    const userIdStr = user?._id?.toString();

    // Count bookings matching email or userId
    const totalBookings = await db.collection('bookings').countDocuments({
      $or: [{ userId: email }, { userId: userIdStr }, { email: email }]
    });

    // Count favorites matching email or userId
    const totalFavorites = await db.collection('favorites').countDocuments({
      $or: [{ userId: email }, { userId: userIdStr }, { email: email }]
    });

    const application = await db.collection('trainerApplications').findOne({ email });

    res.json({
      totalBookings,
      totalFavorites,
      applicationStatus: application ? application.status : null,
      applicationFeedback: application?.feedback || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET All Trainer Applications (admin) ─────────────────────────────────────
app.get('/api/admin/trainer-applications', async (req, res) => {
  try {
    const { status } = req.query;
    const query = status ? { status } : {};
    const applications = await db.collection('trainerApplications')
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();
    res.json(applications);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST Approve Trainer Application ────────────────────────────────────────
app.post('/api/admin/trainer-applications/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;
    const appCol = db.collection('trainerApplications');
    const application = await appCol.findOne({ _id: new ObjectId(id) });
    if (!application) return res.status(404).json({ error: 'Application not found' });

    await appCol.updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: 'Accepted', updatedAt: new Date() } }
    );

    // Update user role to 'trainer' in better-auth 'user' collection
    await db.collection('user').updateOne(
      { email: application.email },
      { $set: { role: 'trainer', updatedAt: new Date() } }
    );

    res.json({ message: 'Application approved. User role updated to trainer.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST Reject Trainer Application ─────────────────────────────────────────
app.post('/api/admin/trainer-applications/:id/reject', async (req, res) => {
  try {
    const { id } = req.params;
    const { feedback } = req.body;
    const appCol = db.collection('trainerApplications');
    const application = await appCol.findOne({ _id: new ObjectId(id) });
    if (!application) return res.status(404).json({ error: 'Application not found' });

    await appCol.updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: 'Rejected', feedback: feedback || '', updatedAt: new Date() } }
    );

    // Keep user role as 'user'
    await db.collection('user').updateOne(
      { email: application.email },
      { $set: { role: 'user', updatedAt: new Date() } }
    );

    res.json({ message: 'Application rejected with feedback.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});