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
  console.log("get-inspections invoked with event:", JSON.stringify(event));
  try {
    const { wallet } = JSON.parse(event.body) || {};
    if (!wallet) {
      throw new Error("Missing wallet in request body");
    }
    if (wallet.toLowerCase() !== ADMIN_WALLET.toLowerCase()) {
      throw new Error("Unauthorized: Only the admin wallet can access inspections");
    }
    const querySnapshot = await db.collection('inspections').where('wallet', '==', wallet).get();
    const inspections = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    return {
      statusCode: 200,
      body: JSON.stringify({ inspections })
    };
  } catch (error) {
    console.error("Error in get-inspections:", error.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};
