import express from "express";
import dotenv from "dotenv";
import AWS from "aws-sdk";
import multer from "multer";
import cors from "cors";
import { Resend } from "resend";
import admin from "firebase-admin";

// ---------------- INIT ----------------
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

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
const upload = multer({ storage });

// ---------------- UTIL ----------------
function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ---------------- ROUTES ----------------

app.get("/", (req, res) => {
  res.send("API is running");
});

// ✅ Send verification code
app.post("/send-verification", async (req, res) => {
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
app.post("/upload", upload.array("files", 10), async (req, res) => {
  console.log("FILES RECEIVED:", req.files);

  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }

    const uploadResults = await Promise.all(
      req.files.map(async (file) => {
        const params = {
          Bucket: BUCKET_NAME,
          Key: `${Date.now()}_${file.originalname}`,
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
app.post("/send-marketing", async (req, res) => {
  const { subject, html } = req.body;
if (!subject || !html) {
  return res.status(400).json({ error: "Missing subject or html" });
}


  try {
    // 🔒 Only send to users who agreed to marketing
    const usersSnap = await db.collection("users")
      .where("marketingConsent", "==", true)
      .get();

    const emails = usersSnap.docs
  .map(doc => doc.data().email)
  .filter(email => !!email);

    if (emails.length === 0) {
      return res.json({ success: true, message: "No users to send" });
    }

    // 🚀 Send emails (batch)
    const BATCH_SIZE = 20;

 for (let i = 0; i < emails.length; i += BATCH_SIZE) {
  const batch = emails.slice(i, i + BATCH_SIZE);

  await resend.emails.send({
    from: "VIPart <news@vipart.ge>",
    to: batch,
    subject,
    html: `
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


// ---------------- START SERVER ----------------
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
