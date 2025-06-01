const admin = require("firebase-admin");

exports.handler = async (event) => {
  console.log("get-remodel-details invoked with event:", JSON.stringify(event));

  try {
    if (!admin.apps.length) {
      console.log("Initializing Firebase Admin...");
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: "turtle-treasure-giveaway",
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
        }),
      });
      console.log("Firebase Admin initialized successfully in get-remodel-details");
    }

    const db = admin.firestore();

    // Get remodelId from query parameters
    const remodelId = event.queryStringParameters?.remodelId;
    if (!remodelId) {
      throw new Error("Missing remodelId in query parameters");
    }

    console.log(`Fetching remodel data for remodelId: ${remodelId}`);
    const docRef = db.collection("remodels").doc(remodelId);
    const doc = await docRef.get();

    if (!doc.exists) {
      throw new Error("Remodel not found");
    }

    const data = doc.data();
    console.log("Remodel data fetched successfully:", data.address);

    return {
      statusCode: 200,
      body: JSON.stringify({
        address: data.address || "N/A",
        measurements: data.measurements || { width: "N/A", length: "N/A", area: "N/A" },
        roofInfo: data.roofInfo || { pitch: "N/A", height: "N/A", roofArea: "N/A", roofMaterial: "N/A" },
        windowDoorCount: data.windowDoorCount || { windows: 0, doors: 0, windowSizes: [], doorSizes: [], isReliable: false },
        materialEstimates: data.materialEstimates || [],
        costEstimates: data.costEstimates || { totalCost: "N/A", costBreakdown: [] },
        timelineEstimate: data.timelineEstimate || "N/A",
        processedImages: data.processedImages || {},
        satelliteImage: data.satelliteImage || null,
        satelliteImageError: data.satelliteImageError || null,
      }),
    };
  } catch (error) {
    console.error("Error in get-remodel-details:", error.message, error.stack);
    return {
      statusCode: error.message.includes("Missing remodelId") || error.message.includes("Remodel not found") ? 400 : 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};