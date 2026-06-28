const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
require('dotenv').config();
const { createRemoteJWKSet, jwtVerify } = require('jose-cjs');

const app = express();
const port = process.env.PORT;

app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:3000',
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization'],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));
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


const JWKS = createRemoteJWKSet(
  new URL(`${process.env.CLIENT_URL || "http://localhost:3000"}/api/auth/jwks`)
);
const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer")) {
    return res.status(401).send({ message: "Unauthorized access: No token provided" });
  }

  const token = authHeader.split(" ")[1];
  if (!token) {
    return res.status(401).send({ message: "Unauthorized access: Invalid token format" });
  }

  try {
    const { payload } = await jwtVerify(token, JWKS);
    req.user = payload;
    next();
  } catch (error) {
    console.error("JWT verify failed:", error.message, error.code); // ← এই লাইনটা যুক্ত করো
    return res.status(401).send({ message: "Unauthorized access: Invalid or expired token" });
  }
};

const verifyAdmin = async (req, res, next) => {
  const user = req.user;
  if (user?.role !== "admin") {
    return res.status(403).send({ message: "Forbidden: Admin access required" });
  }
  next();
};

const verifyTrainer = async (req, res, next) => {
  const user = req.user;

  let trueRole = user?.role;
  try {
    const dbUser = await db.collection('user').findOne({ email: user.email });
    if (dbUser && dbUser.role) {
      trueRole = dbUser.role;
    }
  } catch (err) {
    console.error("Failed to fetch user role from DB in verifyTrainer", err);
  }

  if (trueRole !== "trainer" && trueRole !== "admin") {
    return res.status(403).send({ message: "Forbidden: Trainer access required" });
  }
  next();
};

const verifyNotBlocked = async (req, res, next) => {
  const user = req.user;
  try {
    const dbUser = await db.collection('user').findOne({ email: user.email });
    if (dbUser && dbUser.status === 'blocked') {
      return res.status(403).send({ message: "Action restricted by Admin" });
    }
  } catch (err) {
    console.error("Failed to fetch user block status", err);
  }
  next();
};

// ─── Root Health Check ───────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ message: 'AuraGym Server Running 🏋️', status: 'ok' });
});

// ─── GET Featured Classes (top 6 by booking count) ──────────────────────────
app.get('/api/featured-classes', async (req, res) => {
  try {
    const classes = await db
      .collection('classes')
      .find({ status: { $in: ['Approved', 'approved'] } })
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
    // Public route only shows approved & open classes
    const query = { status: { $in: ['Approved', 'approved'] }, isOpen: true };

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

// ─── ADMIN: GET All Classes with Pagination + Filters ────────────────────────
app.get('/api/admin/classes', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 10, status, visibility } = req.query;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    const query = {};

    // Filter by status
    if (status && status !== 'all') {
      query.status = status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
    }

    // Filter by visibility (only meaningful for Approved classes)
    if (visibility === 'open') query.isOpen = true;
    if (visibility === 'closed') query.isOpen = { $ne: true };

    const col = db.collection('classes');
    const total = await col.countDocuments(query);
    const classes = await col.find(query).sort({ createdAt: -1 }).skip(skip).limit(limitNum).toArray();

    res.json({
      classes,
      total,
      totalPages: Math.ceil(total / limitNum),
      currentPage: pageNum,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ADMIN: Approve Class ────────────────────────────────────────────────────
app.patch('/api/admin/classes/:id/approve', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const classDoc = await db.collection('classes').findOne({ _id: new ObjectId(id) });
    const result = await db.collection('classes').updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: 'Approved', isOpen: true, updatedAt: new Date() } }
    );
    
    if (classDoc && classDoc.trainerEmail) {
      await db.collection('notifications').insertOne({
        email: classDoc.trainerEmail,
        type: 'class_status',
        message: `Your class "${classDoc.className || 'Class'}" has been approved.`,
        read: false,
        createdAt: new Date()
      });
    }
    res.json({ message: 'Class approved successfully', result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ADMIN: Reject Class ─────────────────────────────────────────────────────
app.patch('/api/admin/classes/:id/reject', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const classDoc = await db.collection('classes').findOne({ _id: new ObjectId(id) });
    const result = await db.collection('classes').updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: 'Rejected', updatedAt: new Date() } }
    );

    if (classDoc && classDoc.trainerEmail) {
      await db.collection('notifications').insertOne({
        email: classDoc.trainerEmail,
        type: 'class_status',
        message: `Your class "${classDoc.className || 'Class'}" has been rejected.`,
        read: false,
        createdAt: new Date()
      });
    }
    res.json({ message: 'Class rejected successfully', result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ADMIN: Delete Class ─────────────────────────────────────────────────────
app.delete('/api/admin/classes/:id', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.collection('classes').deleteOne({ _id: new ObjectId(id) });
    res.json({ message: 'Class deleted successfully', result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ADMIN: Toggle Class Visibility (Open / Closed) ──────────────────────────
app.patch('/api/admin/classes/:id/toggle-visibility', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const cls = await db.collection('classes').findOne({ _id: new ObjectId(id) });
    if (!cls) return res.status(404).json({ error: 'Class not found' });
    const newIsOpen = !cls.isOpen;
    await db.collection('classes').updateOne(
      { _id: new ObjectId(id) },
      { $set: { isOpen: newIsOpen, updatedAt: new Date() } }
    );
    res.json({ message: newIsOpen ? 'Class is now Open' : 'Class is now Closed', isOpen: newIsOpen });
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

    const query = {};
    if (req.query.all !== 'true') {
      query.status = 'Approved';
    }

    const forumCol = db.collection('forumPosts');
    const totalPosts = await forumCol.countDocuments(query);

    const posts = await forumCol.aggregate([
      { $match: query },
      { $sort: { createdAt: -1 } },
      { $skip: skip },
      { $limit: limitNum },
      {
        $lookup: {
          from: 'forumComments',
          let: { idStr: { $toString: '$_id' } },
          pipeline: [
            { $match: { $expr: { $eq: ['$postId', '$$idStr'] } } }
          ],
          as: 'comments'
        }
      },
      {
        $addFields: {
          commentCount: { $size: '$comments' }
        }
      },
      {
        $project: { comments: 0 }
      }
    ]).toArray();

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

// ─── GET Single Forum Post by ID ───────────────────────────────────────────────
app.get('/api/forum/:id', async (req, res) => {
  try {
    const postId = req.params.id;
    if (!ObjectId.isValid(postId)) {
      return res.status(400).json({ error: 'Invalid Post ID' });
    }
    const postDetails = await db.collection('forumPosts').findOne({ _id: new ObjectId(postId) });
    if (!postDetails) {
      return res.status(404).json({ error: 'Post not found' });
    }
    res.json(postDetails);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH Toggle Like on Forum Post ─────────────────────────────────────────
app.patch('/api/forum/:id/like', verifyToken, async (req, res) => {
  try {
    const postId = req.params.id;
    const userEmail = req.user?.email;

    if (!ObjectId.isValid(postId)) {
      return res.status(400).json({ error: 'Invalid Post ID' });
    }
    if (!userEmail) {
      return res.status(401).json({ error: 'User email not found in token' });
    }

    const forumCol = db.collection('forumPosts');
    const post = await forumCol.findOne({ _id: new ObjectId(postId) });
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const likedBy = post.likedBy || [];
    const alreadyLiked = likedBy.includes(userEmail);

    if (alreadyLiked) {
      // Unlike: remove user from likedBy, decrement upvotes
      await forumCol.updateOne(
        { _id: new ObjectId(postId) },
        {
          $pull: { likedBy: userEmail },
          $inc: { upvotes: -1 },
        }
      );
    } else {
      // Like: add user to likedBy, increment upvotes
      await forumCol.updateOne(
        { _id: new ObjectId(postId) },
        {
          $addToSet: { likedBy: userEmail },
          $inc: { upvotes: 1 },
        }
      );
    }

    const updated = await forumCol.findOne({ _id: new ObjectId(postId) });
    res.json({
      upvotes: updated.upvotes ?? 0,
      liked: !alreadyLiked,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET Comments for a Forum Post ───────────────────────────────────────────
app.get('/api/forum/:id/comments', async (req, res) => {
  try {
    const postId = req.params.id;
    if (!ObjectId.isValid(postId)) return res.status(400).json({ error: 'Invalid Post ID' });

    const comments = await db.collection('forumComments')
      .find({ postId })
      .sort({ createdAt: 1 })
      .toArray();

    res.json(comments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST Add Comment / Reply ─────────────────────────────────────────────────
app.post('/api/forum/:id/comments', verifyToken, async (req, res) => {
  try {
    const postId = req.params.id;
    const { content, parentId, authorName } = req.body;
    const authorEmail = req.user?.email;

    if (!content?.trim()) return res.status(400).json({ error: 'Comment content is required' });
    if (!ObjectId.isValid(postId)) return res.status(400).json({ error: 'Invalid Post ID' });

    // Fetch role from DB (trusted source, not client)
    const dbUser = await db.collection('user').findOne({ email: authorEmail });
    const authorRole = dbUser?.role || req.user?.role || 'user';
    const resolvedName = authorName || dbUser?.name || req.user?.name || 'Anonymous';

    const comment = {
      postId,
      parentId: parentId || null,
      content: content.trim(),
      authorEmail,
      authorName: resolvedName,
      authorRole,
      isEdited: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await db.collection('forumComments').insertOne(comment);
    res.status(201).json({ ...comment, _id: result.insertedId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH Edit Comment ───────────────────────────────────────────────────────
app.patch('/api/forum/:id/comments/:commentId', verifyToken, async (req, res) => {
  try {
    const { commentId } = req.params;
    const { content } = req.body;
    const userEmail = req.user?.email;

    if (!ObjectId.isValid(commentId)) return res.status(400).json({ error: 'Invalid comment ID' });
    if (!content?.trim()) return res.status(400).json({ error: 'Content is required' });

    const comment = await db.collection('forumComments').findOne({ _id: new ObjectId(commentId) });
    if (!comment) return res.status(404).json({ error: 'Comment not found' });
    if (comment.authorEmail !== userEmail) return res.status(403).json({ error: 'Forbidden' });

    await db.collection('forumComments').updateOne(
      { _id: new ObjectId(commentId) },
      { $set: { content: content.trim(), isEdited: true, updatedAt: new Date() } }
    );

    res.json({ message: 'Comment updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE Comment (cascades to replies) ────────────────────────────────────
app.delete('/api/forum/:id/comments/:commentId', verifyToken, async (req, res) => {
  try {
    const { commentId } = req.params;
    const userEmail = req.user?.email;

    if (!ObjectId.isValid(commentId)) return res.status(400).json({ error: 'Invalid comment ID' });

    const comment = await db.collection('forumComments').findOne({ _id: new ObjectId(commentId) });
    if (!comment) return res.status(404).json({ error: 'Comment not found' });

    // Allow delete if own comment or admin
    const dbUser = await db.collection('user').findOne({ email: userEmail });
    if (comment.authorEmail !== userEmail && dbUser?.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Delete comment + all its replies
    await db.collection('forumComments').deleteMany({
      $or: [{ _id: new ObjectId(commentId) }, { parentId: commentId }]
    });

    res.json({ message: 'Comment deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST Create Forum Post ──────────────────────────────────────────────────
app.post('/api/forum', verifyToken, verifyNotBlocked, async (req, res) => {
  try {
    const { title, description, image, authorName, authorEmail, role, category } = req.body;

    if (!title || !description) {
      return res.status(400).json({ error: 'Title and description are required' });
    }

    // ── Check Soft Block ────────────────────────────────────────────────────────
    if (authorEmail) {
      const userDoc = await db.collection('user').findOne({ email: authorEmail });
      if (userDoc && userDoc.status === 'blocked') {
        return res.status(403).json({ error: 'Action restricted by Admin' });
      }
    }

    const newPost = {
      title,
      description,
      image: image || '',
      category: category || 'Motivation',
      authorName: authorName || 'Unknown',
      authorEmail: authorEmail || '',
      role: role || 'Trainer',
      status: 'Pending',
      upvotes: 0,
      downvotes: 0,
      createdAt: new Date(),
    };

    const result = await db.collection('forumPosts').insertOne(newPost);
    res.status(201).json({ message: 'Forum post created successfully', id: result.insertedId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ─── DELETE Forum Post ───────────────────────────────────────────────────────
app.delete('/api/forum/:id', verifyToken, async (req, res) => {
  try {
    const postId = req.params.id;
    if (!ObjectId.isValid(postId)) {
      return res.status(400).json({ error: 'Invalid Post ID' });
    }
    const result = await db.collection('forumPosts').deleteOne({ _id: new ObjectId(postId) });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }
    res.json({ message: 'Post deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH Approve Forum Post ────────────────────────────────────────────────
app.patch('/api/forum/:id/approve', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const postId = req.params.id;
    if (!ObjectId.isValid(postId)) {
      return res.status(400).json({ error: 'Invalid Post ID' });
    }
    const postDoc = await db.collection('forumPosts').findOne({ _id: new ObjectId(postId) });
    await db.collection('forumPosts').updateOne(
      { _id: new ObjectId(postId) },
      { $set: { status: 'Approved' } }
    );
    if (postDoc && postDoc.authorEmail) {
      await db.collection('notifications').insertOne({
        email: postDoc.authorEmail,
        type: 'forum_status',
        message: `Your forum post "${postDoc.title || 'Post'}" has been approved.`,
        read: false,
        createdAt: new Date()
      });
    }
    res.json({ message: 'Post approved successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH Reject Forum Post ─────────────────────────────────────────────────
app.patch('/api/forum/:id/reject', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const postId = req.params.id;
    if (!ObjectId.isValid(postId)) {
      return res.status(400).json({ error: 'Invalid Post ID' });
    }
    const postDoc = await db.collection('forumPosts').findOne({ _id: new ObjectId(postId) });
    await db.collection('forumPosts').updateOne(
      { _id: new ObjectId(postId) },
      { $set: { status: 'Rejected' } }
    );
    if (postDoc && postDoc.authorEmail) {
      await db.collection('notifications').insertOne({
        email: postDoc.authorEmail,
        type: 'forum_status',
        message: `Your forum post "${postDoc.title || 'Post'}" has been rejected.`,
        read: false,
        createdAt: new Date()
      });
    }
    res.json({ message: 'Post rejected successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET All Transactions (Admin) ─────────────────────────────────────────────
app.get('/api/admin/transactions', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const payments = await db.collection('payments')
      .find({})
      .sort({ paidAt: -1 })
      .toArray();

    // Enrich with user photo from user collection
    const enriched = await Promise.all(payments.map(async (tx) => {
      const email = tx.userEmail || tx.email;
      if (email) {
        const user = await db.collection('user').findOne({ email }, { projection: { image: 1, name: 1 } });
        if (user) {
          return { ...tx, userImage: user.image || null, userName: user.name || null };
        }
      }
      return tx;
    }));

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET Single Class by ID ──────────────────────────────────────────────────
app.get('/api/classes/:id', async (req, res) => {
  try {
    const classId = req.params.id;
    const cls = await db.collection('classes').findOne({ _id: new ObjectId(classId) });
    if (!cls) return res.status(404).json({ error: 'Class not found' });
    res.json(cls);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST Create New Class ───────────────────────────────────────────────────
app.post('/api/classes', verifyToken, verifyTrainer, async (req, res) => {
  try {
    const {
      className, image, category, level, duration, schedule, price, description, trainerEmail, maxStudents
    } = req.body;

    if (!className || !category || !price) {
      return res.status(400).json({ error: 'Class name, category, and price are required' });
    }

    const newClass = {
      className,
      name: className,
      image: image || '',
      category,
      level: level || 'Beginner',
      duration: duration || '60 mins',
      schedule: schedule || { days: [], time: '' },
      price: Number(price) || 0,
      description: description || '',
      trainerEmail: trainerEmail || '',
      maxStudents: parseInt(maxStudents) || 20,
      status: 'Pending',
      bookingCount: 0,
      createdAt: new Date(),
    };

    const result = await db.collection('classes').insertOne(newClass);
    res.status(201).json({ message: 'Class created successfully', id: result.insertedId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET Trainer Classes ─────────────────────────────────────────────────────
app.get('/api/trainer/:email/classes', verifyToken, verifyTrainer, async (req, res) => {
  try {
    const { email } = req.params;
    const classes = await db.collection('classes').find({ trainerEmail: email }).sort({ createdAt: -1 }).toArray();
    res.json(classes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET Trainer Bookings (Earnings & Transactions) ────────────────────────
app.get('/api/trainer/:email/bookings', verifyToken, verifyTrainer, async (req, res) => {
  try {
    const { email } = req.params;

    // 1. Find all classes created by this trainer
    const trainerClasses = await db.collection('classes').find({ trainerEmail: email }).toArray();
    const classIds = trainerClasses.map(c => c._id.toString());

    if (classIds.length === 0) {
      return res.json([]);
    }

    // 2. Find all bookings for these classes
    const bookings = await db.collection('bookings')
      .find({ classId: { $in: classIds } })
      .sort({ createdAt: -1 })
      .toArray();

    // 3. For each booking, fetch user details
    const result = await Promise.all(bookings.map(async (b) => {
      // Find the user who made the booking
      // userId might be an email or an ObjectId string
      const user = await db.collection('user').findOne({
        $or: [{ email: b.email }, { email: b.userId }, { _id: new ObjectId(ObjectId.isValid(b.userId) ? b.userId : "000000000000000000000000") }]
      });

      const cls = trainerClasses.find(c => c._id.toString() === b.classId);

      return {
        ...b,
        classDetails: cls || null,
        userDetails: user ? { name: user.name, image: user.image, email: user.email, number: user.number || user.phone || "Not Provided" } : null
      };
    }));

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT Update Class ────────────────────────────────────────────────────────
app.put('/api/classes/:id', verifyToken, verifyTrainer, async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = { ...req.body, updatedAt: new Date() };
    delete updateData._id;
    const result = await db.collection('classes').updateOne(
      { _id: new ObjectId(id) },
      { $set: updateData }
    );
    res.json({ message: 'Class updated', result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE Class ────────────────────────────────────────────────────────────
app.delete('/api/classes/:id', verifyToken, verifyTrainer, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.collection('classes').deleteOne({ _id: new ObjectId(id) });
    res.json({ message: 'Class deleted', result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET Class Attendees ─────────────────────────────────────────────────────
app.get('/api/classes/:id/attendees', verifyToken, verifyTrainer, async (req, res) => {
  try {
    const { id } = req.params;
    const bookings = await db.collection('bookings').find({ classId: id }).toArray();
    res.json(bookings);
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

    const booking = await db.collection('bookings').findOne({
      classId,
      $or: [{ userId }, { email: userId }]
    });
    res.json({ isBooked: !!booking });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET User Bookings (with class details) ──────────────────────────────────
app.get('/api/users/:userId/bookings', verifyToken, async (req, res) => {
  try {
    const { userId } = req.params;

    // The db schema sometimes uses email as userId or string, handle normally
    const bookings = await db.collection('bookings')
      .find({ $or: [{ userId }, { email: userId }, { 'user.email': userId }] })
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

// ─── GET User Payments (Transactions) ────────────────────────────────────────
app.get('/api/users/:userId/payments', verifyToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const payments = await db.collection('payments')
      .find({ $or: [{ userId }, { userEmail: userId }] })
      .sort({ paidAt: -1 })
      .toArray();
    res.json(payments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST Booking (Stripe Success hook) ──────────────────────────────────────
app.post('/api/classes/booking', verifyToken, verifyNotBlocked, async (req, res) => {
  try {
    const { amount, classId, classTitle, quantity, email, paymentType, transactionId, paymentStatus, userId } = req.body;

    // ── Check class capacity before allowing booking ──────────────────────────
    if (classId && ObjectId.isValid(classId)) {
      const classDoc = await db.collection('classes').findOne({ _id: new ObjectId(classId) });
      if (classDoc && classDoc.maxStudents) {
        const currentBookings = classDoc.bookingCount || 0;
        if (currentBookings >= classDoc.maxStudents) {
          return res.status(400).json({ error: 'This class is full. No more bookings are allowed.' });
        }
      }
    }

    // ── Check Soft Block ────────────────────────────────────────────────────────
    if (email) {
      const userDoc = await db.collection('user').findOne({ email });
      if (userDoc && userDoc.status === 'blocked') {
        return res.status(403).json({ error: 'Action restricted by Admin' });
      }
    }

    // Prevent double booking for the same class by the same user
    const checkUserBooking = await db.collection('bookings').findOne({ classId, $or: [{ userId }, { email }] });
    if (checkUserBooking) {
      return res.status(200).send({ message: 'User has already booked this class' });
    }

    const bookingData = {
      classId,
      classTitle,
      userId: userId || email, // Prioritize explicit userId
      email: email,
      quantity,
      amount,
      transactionId,
      paymentStatus,
      bookingDate: new Date(),
      createdAt: new Date(),
    };

    const isBookingExist = await db.collection('bookings').findOne({ transactionId });
    if (isBookingExist) {
      return res.status(200).send({ message: 'Already paid' });
    }

    const bookingRes = await db.collection('bookings').insertOne(bookingData);

    // Update class capacity/booking count
    await db.collection('classes').updateOne(
      { _id: new ObjectId(classId) },
      {
        $inc: {
          bookingCount: quantity ? parseInt(quantity) : 1,
        },
      }
    );

    // Upgrade user role to "member" if they are a "user"
    if (email) {
      await db.collection('user').updateOne(
        { email, role: 'user' },
        { $set: { role: 'member', updatedAt: new Date() } }
      );
    }

    const paymentData = {
      userId: userId || email,
      userEmail: email,
      amount,
      transactionId,
      paymentStatus,
      paymentType,
      paidAt: new Date(),
    };

    await db.collection('payments').insertOne(paymentData);

    // Create notification for booking
    await db.collection('notifications').insertOne({
      email: email,
      type: 'booking',
      message: `Your booking for ${classTitle || 'a class'} was successful.`,
      read: false,
      createdAt: new Date()
    });
    
    // Notify trainer
    if (classId && ObjectId.isValid(classId)) {
      const classDoc = await db.collection('classes').findOne({ _id: new ObjectId(classId) });
      if (classDoc && classDoc.trainerEmail) {
        await db.collection('notifications').insertOne({
          email: classDoc.trainerEmail,
          type: 'booking',
          message: `A user has booked your class: ${classTitle || classDoc.className}.`,
          read: false,
          createdAt: new Date()
        });
      }
    }

    res.send(bookingRes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET User Favorites (with class details) ──────────────────────────────────
app.get('/api/users/:userId/favorites', verifyToken, async (req, res) => {
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
app.post('/api/favorites/toggle', verifyToken, async (req, res) => {
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
app.post('/api/trainer-apply', verifyToken, verifyNotBlocked, async (req, res) => {
  try {
    const { name, email, experience, specialty, bio } = req.body;
    if (!email || !experience || !specialty) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // ── Check Soft Block ────────────────────────────────────────────────────────
    const userDoc = await db.collection('user').findOne({ email });
    if (userDoc && userDoc.status === 'blocked') {
      return res.status(403).json({ error: 'Action restricted by Admin' });
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

    // Create notification for admin
    await db.collection('notifications').insertOne({
      role: 'admin',
      type: 'trainer_apply',
      message: `New trainer application from ${name} (${email}).`,
      read: false,
      createdAt: new Date()
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
app.get('/api/users/:email/stats', verifyToken, async (req, res) => {
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
      userStatus: user?.status || 'active'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET All Trainer Applications (admin) ─────────────────────────────────────
app.get('/api/admin/trainer-applications', verifyToken, verifyAdmin, async (req, res) => {
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

    // Update user role to 'trainer'
    await db.collection('user').updateOne(
      { email: application.email },
      { $set: { role: 'trainer', updatedAt: new Date() } }
    );

    // Notification
    await db.collection('notifications').insertOne({
      email: application.email,
      type: 'trainer_status',
      message: `Congratulations! Your trainer application has been approved.`,
      read: false,
      createdAt: new Date()
    });

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

    // Notification
    await db.collection('notifications').insertOne({
      email: application.email,
      type: 'trainer_status',
      message: `Your trainer application was rejected. ${feedback ? 'Feedback: ' + feedback : ''}`,
      read: false,
      createdAt: new Date()
    });

    res.json({ message: 'Application rejected with feedback.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ADMIN: GET Dashboard Stats ──────────────────────────────────────────────
app.get('/api/admin/stats', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const totalUsers = await db.collection('user').countDocuments();
    const totalClasses = await db.collection('classes').countDocuments();
    const totalBookings = await db.collection('bookings').countDocuments();

    res.json({
      totalUsers,
      totalClasses,
      totalBookings
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ADMIN: GET All Users (Paginated & Filtered) ─────────────────────────────
app.get('/api/admin/users', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 10, search = '', role = 'all' } = req.query;

    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const skip = (pageNum - 1) * limitNum;

    const query = {};

    // Role filter
    if (role && role !== 'all') {
      query.role = role;
    }

    // Search (Name or Email)
    if (search && search.trim() !== '') {
      const searchRegex = { $regex: search.trim(), $options: 'i' };
      query.$or = [{ name: searchRegex }, { email: searchRegex }];
    }

    const usersCol = db.collection('user');

    // Fetch stats globally (not just for filtered results)
    const totalUsersCount = await usersCol.countDocuments();
    const activeUsersCount = await usersCol.countDocuments({ status: { $ne: 'blocked' } });
    const blockedUsersCount = await usersCol.countDocuments({ status: 'blocked' });

    // Count for pagination
    const totalMatchingUsers = await usersCol.countDocuments(query);

    const users = await usersCol
      .find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .toArray();

    res.json({
      users,
      totalUsers: totalMatchingUsers,
      totalPages: Math.ceil(totalMatchingUsers / limitNum),
      currentPage: pageNum,
      summaryStats: {
        total: totalUsersCount,
        active: activeUsersCount,
        blocked: blockedUsersCount
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ADMIN: Block/Unblock User ───────────────────────────────────────────────
app.patch('/api/admin/users/:id/block', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body; // 'blocked' or 'active'

    if (status !== 'blocked' && status !== 'active') {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const user = await db.collection('user').findOne({ _id: new ObjectId(id) });
    const result = await db.collection('user').updateOne(
      { _id: new ObjectId(id) },
      { $set: { status, updatedAt: new Date() } }
    );
    
    if (user && user.email) {
      await db.collection('notifications').insertOne({
        email: user.email,
        type: 'account_status',
        message: `Your account has been ${status} by an admin.`,
        read: false,
        createdAt: new Date()
      });
    }

    res.json({ message: `User status updated to ${status}`, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ADMIN: Change User Role ───────────────────────────────────────────────────
app.patch('/api/admin/users/:id/role', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;

    if (!['admin', 'trainer', 'user'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    const user = await db.collection('user').findOne({ _id: new ObjectId(id) });
    const result = await db.collection('user').updateOne(
      { _id: new ObjectId(id) },
      { $set: { role, updatedAt: new Date() } }
    );
    
    if (user && user.email) {
      await db.collection('notifications').insertOne({
        email: user.email,
        type: 'role_change',
        message: `Your role has been updated to ${role} by an admin.`,
        read: false,
        createdAt: new Date()
      });
    }

    res.json({ message: `User role updated to ${role}`, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── NOTIFICATIONS API ────────────────────────────────────────────────────────
app.get('/api/notifications/:email', verifyToken, async (req, res) => {
  try {
    const { email } = req.params;

    // Notifications for this specific user or role="admin" if user is an admin
    const user = await db.collection('user').findOne({ email });
    const query = { $or: [{ email: email }] };
    if (user && user.role === 'admin') {
      query.$or.push({ role: 'admin' });
    }

    const notifications = await db.collection('notifications')
      .find(query)
      .sort({ createdAt: -1 })
      .limit(10)
      .toArray();

    res.json(notifications);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/notifications', async (req, res) => {
  try {
    const { email, role, type, message } = req.body;
    if (!email && !role) {
      return res.status(400).json({ error: 'Missing target email or role' });
    }

    const notification = {
      email,
      role,
      type,
      message,
      read: false,
      createdAt: new Date(),
    };

    const result = await db.collection('notifications').insertOne(notification);
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/notifications/:id/mark-read', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.collection('notifications').updateOne(
      { _id: new ObjectId(id) },
      { $set: { read: true } }
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
