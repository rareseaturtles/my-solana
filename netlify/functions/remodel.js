const admin = require("firebase-admin");
const fetch = require("node-fetch");

exports.handler = async (event) => {
  console.log("remodel invoked with event:", JSON.stringify(event));

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
      console.log("Firebase Admin initialized successfully in remodel");
    }

    const db = admin.firestore();
    const storage = admin.storage();
    const bucket = storage.bucket("turtle-treasure-giveaway.appspot.com");

    if (!event.body) {
      throw new Error("Missing request body");
    }

    let body;
    try {
      body = JSON.parse(event.body);
    } catch (parseError) {
      throw new Error("Invalid request body: Failed to parse JSON");
    }

    const { address, photos, windowCount, doorCount } = body;

    if (!address) {
      throw new Error("Missing address in request body");
    }

    if (!photos || typeof photos !== "object") {
      console.error("Photos is not an object:", photos);
      throw new Error("Invalid photos data: Expected an object with directions");
    }

    const directions = ["north", "south", "east", "west"];
    for (const direction of directions) {
      if (photos[direction] && !Array.isArray(photos[direction])) {
        console.error(`Photos for ${direction} is not an array:`, photos[direction]);
        throw new Error(`Invalid photos data for ${direction}: Expected an array`);
      }
    }

    const allImages = directions
      .flatMap(direction => photos[direction] || [])
      .filter(image => image && typeof image === "string" && image.startsWith("data:image/"));
    console.log(`Processing remodel for address: ${address}, total user images received: ${allImages.length}`);

    const addressResponse = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}`,
      { headers: { "User-Agent": "IndyHomeImprovements/1.0" } }
    );
    const addressData = await addressResponse.json();

    if (!addressData.length) {
      throw new Error("Invalid address: No results found");
    }

    console.log("Address validated:", addressData[0].display_name);
    const lat = parseFloat(addressData[0].lat);
    const lon = parseFloat(addressData[0].lon);

    const buildingData = await getBuildingData(lat, lon);
    const measurements = buildingData.measurements;
    const roofInfo = await getRoofInfo(lat, lon, buildingData.roofInfo, process.env.GOOGLE_MAPS_API_KEY);
    const isMeasurementsReliable = buildingData.isReliable;

    let windowDoorInfo;
    if (windowCount && doorCount) {
      windowDoorInfo = {
        windows: parseInt(window...

Something went wrong, please refresh to reconnect or try again.