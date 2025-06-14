const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: "turtle-treasure-giveaway",
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    })
  });
}

const db = admin.firestore();
const ADMIN_WALLET = process.env.ADMIN_WALLET_ADDRESS;

exports.handler = async (event) => {
  console.log("save-inspection invoked with event:", JSON.stringify(event));
  try {
    const data = JSON.parse(event.body) || {};
    const { wallet } = data;
    if (!wallet) {
      throw new Error("Missing wallet in request body");
    }
    if (wallet.toLowerCase() !== ADMIN_WALLET.toLowerCase()) {
      throw new Error("Unauthorized: Only the admin wallet can save inspections");
    }
    const docRef = await db.collection('inspections').add(data);
    await db.collection('AuditLogs').add({
      action: 'save-inspection',
      wallet: wallet,
      jobId: docRef.id,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Inspection saved', id: docRef.id })
    };
  } catch (error) {
    console.error("Error in save-inspection:", error.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};
