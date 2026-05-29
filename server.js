import express from "express";
import dotenv from "dotenv";
import AWS from "aws-sdk";
import multer from "multer";
import cors from "cors";
import { Resend } from "resend";
import admin from "firebase-admin";
import rateLimit from "express-rate-limit";
import crypto from "crypto";

// ---------------- INIT ----------------
dotenv.config();

const ADMIN_SECRET = process.env.ADMIN_SECRET;

const RESEND_WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET;

const bogPublicKey = process.env.BOG_PUBLIC_KEY;
const bogSecretKey = process.env.BOG_SECRET_KEY;

const app = express();
app.use(cors({
  origin: [
    "https://vipart.ge",
  ],
}));
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

const verificationLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 5,
});


const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,
});


// ---------------- RESEND ----------------
const resend = new Resend(process.env.RESEND_API_KEY);

console.log("FIREBASE_KEY:", process.env.FIREBASE_KEY ? "EXISTS" : "MISSING");

let serviceAccount;

try {
  serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
  console.log("FIREBASE JSON OK");
} catch (e) {
  console.log("FIREBASE JSON ERROR:", e.message);
}

// ---------------- FIREBASE ADMIN ----------------
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// ---------------- AWS S3 ----------------
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});

const s3 = new AWS.S3();
const BUCKET_NAME = process.env.S3_BUCKET_NAME;

// ---------------- MULTER ----------------
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
  },
});

// ---------------- UTIL ----------------
function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function getTrialEndDate(createdAt) {
  const date = new Date(createdAt || Date.now());
  date.setDate(date.getDate() + 30);
  return date.getTime();
}

function canPost(user) {
  return Date.now() < user.trialEndAt;
}


function adminMiddleware(req, res, next) {
  const secret = req.headers["x-admin-secret"];

  if (!secret || secret !== ADMIN_SECRET) {
    return res.status(403).json({ error: "Forbidden" });
  }

  next();
}


function verifyResendSignature(req) {
  const signature = req.headers["resend-signature"];

  if (!signature || !RESEND_WEBHOOK_SECRET) return false;

  const computed = crypto
    .createHmac("sha256", RESEND_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest("hex");

  return computed === signature;
}


// ---------------- ROUTES ----------------

app.get("/", (req, res) => {
  res.send("API is running");
});

// ✅ Send verification code
app.post("/send-verification", verificationLimiter, async (req, res) => {
  const { email, userId } = req.body;

  try {
    const code = generateCode();

    // Save code in Firestore
    await db.collection("verificationCodes").doc(userId).set({
      code,
      email,
      expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
    });

    // Send email via Resend
    await resend.emails.send({
      from: "VIPart <noreply@vipart.ge>",
      to: email,
      subject: "Your verification code",
      html: `
          <div style="text-align:center;">
         <img src="https://vipart.ge/logo4-512.png" width="120" />
         </div>

        <h2>VIPart Verification</h2>
        <p>Your code:</p>
        <h1>${code}</h1>
        <p>This code expires in 10 minutes.</p>
      `,
    });

    res.json({ success: true });

  } catch (err) {
    console.error("Send verification error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Verify code
app.post("/verify-code", async (req, res) => {
  const { userId, code } = req.body;


  try {
    const docRef = db.collection("verificationCodes").doc(userId);
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
      return res.status(400).json({ error: "Code not found" });
    }

    const data = docSnap.data();

    if (data.code !== code) {
      return res.status(400).json({ error: "Invalid code" });
    }

    if (Date.now() > data.expiresAt) {
      return res.status(400).json({ error: "Code expired" });
    }

    // Mark user as verified
    await db.collection("users").doc(userId).set({
  verified: true,
}, { merge: true });

    // Delete used code
    await docRef.delete();

    res.json({ success: true });

  } catch (err) {
    console.error("Verify code error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Upload images to S3
app.post(
  "/upload",
  uploadLimiter,
  upload.array("files", 10),
  async (req, res) => {
  console.log("FILES RECEIVED:", req.files);

  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }

const allowedTypes = [
  "image/jpeg",
  "image/png",
  "image/webp",
];

for (const file of req.files) {
  if (!allowedTypes.includes(file.mimetype)) {
    return res.status(400).json({
      error: "Invalid file type",
    });
  }
}

    const uploadResults = await Promise.all(
      req.files.map(async (file) => {
        const params = {
          Bucket: BUCKET_NAME,
          Key: `${crypto.randomUUID()}_${Date.now()}`,
          Body: file.buffer,
          ContentType: file.mimetype,
        };

        const result = await s3.upload(params).promise();
        return result;
      })
    );

    const urls = uploadResults.map((r) => r.Location);
    res.json({ urls });

  } catch (err) {
    console.error("S3 upload error:", err);
    res.status(500).json({ error: err.message });
  }
});


// ✅ Send marketing email (ads / listings)
app.post("/send-marketing", adminMiddleware, async (req, res) => {
  const { subject, html, toEmails, sendToAll } = req.body;
if (!subject || !html) {
  return res.status(400).json({ error: "Missing subject or html" });
}


  try {
    // 🔒 Only send to users who agreed to marketing
let emails = [];

if (Array.isArray(toEmails) && toEmails.length > 0) {
  emails = toEmails.filter(email =>
    typeof email === "string" && email.includes("@")
  );
}

    if (emails.length === 0) {
      return res.json({ success: true, message: "No users to send" });
    }

    // 🚀 Send emails (batch)
    const BATCH_SIZE = 20;

 for (let i = 0; i < emails.length; i += BATCH_SIZE) {
  const batch = emails.slice(i, i + BATCH_SIZE);

  await resend.emails.send({
    from: "VIPart Real Estate <news@vipart.ge>",
    to: batch,
    subject,
    html: `
    <div style="text-align:center;">
    <img src="https://vipart.ge/logo4-512.png" width="120" />
    </div>


     ${html}

      <br/><br/>
      <p style="font-size:12px;color:gray;">
        If you no longer want to receive emails, contact us to unsubscribe.
      </p>
    `,
  });
}

    res.json({ success: true, sentTo: emails.length });

  } catch (err) {
    console.error("Marketing email error:", err);
    res.status(500).json({ error: err.message });
  }
});



app.post("/inbound-email", async (req, res) => {
  try {

    // ✅ VERIFY REQUEST COMES FROM RESEND
    if (!verifyResendSignature(req)) {
      return res.status(401).send("Invalid signature");
    }

    console.log("📩 VERIFIED INBOUND EMAIL:", req.body);

    const event = req.body;

    if (event.type === "email.received") {
      const email = event.data;

      await db.collection("emails").add({
        from: email.from || "",
        to: email.to || [],
        subject: email.subject || "",
        text: email.text || "",
        html: email.html || "",
        createdAt: Date.now(),
        read: false
      });
    }

    res.status(200).send("ok");

  } catch (err) {
    console.error("Inbound email error:", err);
    res.status(500).send("error");
  }
});




app.post("/migrate-trials", adminMiddleware, async (req, res) => {
  try {
    const usersRef = db.collection("users");
    const snapshot = await usersRef.get();

    const batch = db.batch();

    snapshot.forEach((doc) => {
      const data = doc.data();

      if (!data.trialEndAt) {
        const createdAt = data.createdAt || Date.now();
        const trialEndAt = getTrialEndDate(createdAt);

        batch.update(doc.ref, {
          trialStartAt: createdAt,
          trialEndAt,
          plan: "gift_trial",
          canPostListings: true
        });
      }
    });

    await batch.commit();

    res.json({ success: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});



app.post("/create-payment", async (req, res) => {
  try {
    const { type, userId } = req.body;




async function getBogToken() {
  const response = await fetch(
    "https://oauth2.bog.ge/auth/realms/bog/protocol/openid-connect/token",
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: bogPublicKey,
        client_secret: bogSecretKey,
      }),
    }
  );

  const data = await response.json();

  return data.access_token;
}





if (!userId || typeof userId !== "string") {
  return res.status(400).json({ error: "Invalid userId" });
}

if (!type || typeof type !== "string") {
  return res.status(400).json({ error: "Invalid type" });
}

const orderId = db.collection("pendingPayments").doc().id;


    let amount = 0;

    if (type === "limitless") amount = 25;
  else if (type === "extra_listing") amount = 3;
  else if (type === "vip" || type === "gold" || type === "extra_gold") {
  const days = Number(req.body.days);

if (!Number.isFinite(days) || days < 1 || days > 365) {
  return res.status(400).json({ error: "Invalid days" });
}

  const listingId = req.body.listingId;

  if (!listingId) {
    return res.status(400).json({ error: "Missing listingId" });
  }



  const listingRef = db.collection("listings").doc(listingId);
  const listingSnap = await listingRef.get();

  if (!listingSnap.exists) {
    return res.status(404).json({ error: "Listing not found" });
  }


  const baseTime = Date.now();

  const duration = days * 24 * 60 * 60 * 1000;
  const newUntil = baseTime + duration;

let updateData = null;

if (type === "extra_gold") {
  amount = 2.9 * days;
  updateData = {
    extraGoldUntil: newUntil,
    boostLevel: 3,
    isExtraGold: true,
    isGold: true,
    isVip: true,
  };
}

else if (type === "gold") {
  amount = 2 * days;
  updateData = {
    goldUntil: newUntil,
    boostLevel: 2,
    isGold: true,
    isVip: true,
  };
}

else if (type === "vip") {
  amount = 1 * days;
  updateData = {
    vipUntil: newUntil,
    boostLevel: 1,
    isVip: true,
  };
}

    else {
      return res.status(400).json({
        error: "Invalid payment type",
      });
    }
}
await db.collection("pendingPayments").doc(orderId).set({
  orderId,
  userId,
  type,
  listingId: req.body.listingId || null,
  days: Number(req.body.days || 1),
  amount,
  status: "pending",
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

    console.log("PAYMENT TYPE:", type);
    console.log("USER ID:", userId);
    console.log("AMOUNT:", amount);


    // fake redirect for now
    const token = await getBogToken();

const paymentRes = await fetch(
  "https://api.bog.ge/payments/v1/ecommerce/orders",
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      callback_url:
        "https://vipart-backend.onrender.com/payment-callback",

      external_order_id: orderId,

      purchase_units: {
        currency: "GEL",
        total_amount: amount,
      },

      redirect_urls: {
        success:
          "https://vipart.ge/payment-success",
        fail:
          "https://vipart.ge/payment-fail",
      },

      basket: [
        {
          product_id: type,
          description: type,
          quantity: 1,
          unit_price: amount,
        },
      ],
    }),
  }
);


console.log("BOG RAW STATUS:", paymentRes.status);
console.log("BOG RAW RESPONSE TEXT:", await paymentRes.clone().text());


const paymentData = await paymentRes.json();

console.log(paymentData);

res.json({
  paymentUrl:
    paymentData?._links?.redirect?.href,
});

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});




// ---------------- START SERVER ----------------
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
