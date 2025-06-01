const admin = require("firebase-admin");

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

    if (!event.body) {
      throw new Error("Missing request body");
    }

    let body;
    try {
      body = JSON.parse(event.body);
    } catch (parseError) {
      throw new Error("Invalid request body: Failed to parse JSON");
    }

    const { address, images, windowCount, doorCount } = body;

    if (!address) {
      throw new Error("Missing address in request body");
    }

    console.log(`Processing remodel for address: ${address}, number of images: ${images?.length || 0}`);

    const addressResponse = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}`,
      { headers: { "User-Agent": "IndyHomeImprovements/1.0" } }
    );
    const addressData = await addressResponse.json();

    if (!addressData.length) {
      throw new Error("Invalid address: No results found");
    }

    console.log("Address validated:", addressData[0].display_name);
    const lat = addressData[0].lat;
    const lon = addressData[0].lon;

    const buildingData = await getBuildingData(lat, lon);
    const measurements = buildingData.measurements;
    const roofInfo = buildingData.roofInfo;

    const windowDoorInfo = windowCount && doorCount
      ? { windows: parseInt(windowCount), doors: parseInt(doorCount), windowSizes: [], doorSizes: [], image: null }
      : await analyzePhotos(images || []);

    const windowDoorCount = {
      windows: windowDoorInfo.windows,
      doors: windowDoorInfo.doors,
      windowSizes: windowDoorInfo.windowSizes,
      doorSizes: windowDoorInfo.doorSizes,
    };
    const processedImage = windowDoorInfo.image;
    console.log("Processed image included in response:", !!processedImage);

    const materialEstimates = calculateMaterialEstimates(measurements, windowDoorCount, roofInfo);

    const costEstimates = calculateCostEstimates(materialEstimates, windowDoorCount, measurements.area);
    const timelineEstimate = calculateTimeline(measurements.area, windowDoorCount);

    const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
    let satelliteImage = null;
    let satelliteImageError = null;
    if (GOOGLE_MAPS_API_KEY) {
      satelliteImage = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lon}&zoom=18&size=300x300&maptype=satellite&key=${GOOGLE_MAPS_API_KEY}`;
      console.log("Generated Google Maps satellite image URL:", satelliteImage);

      try {
        const imageResponse = await fetch(satelliteImage);
        if (!imageResponse.ok) {
          const errorText = await imageResponse.text();
          console.error("Google Maps API request failed:", imageResponse.status, errorText);
          satelliteImageError = `Google Maps API error: ${errorText}`;
          satelliteImage = null;
        }
      } catch (error) {
        console.error("Error fetching Google Maps satellite image:", error.message);
        satelliteImageError = `Network error: ${error.message}`;
        satelliteImage = null;
      }
    } else {
      console.log("Google Maps API key missing, satellite image not generated.");
      satelliteImageError = "Google Maps API key is missing. Please ensure the Maps Static API is enabled and the key is configured.";
    }

    const remodelEntry = {
      address: addressData[0].display_name,
      measurements,
      windowDoorCount,
      materialEstimates,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    };

    const docRef = await db.collection("remodels").add(remodelEntry);
    console.log("Remodel entry saved to Firestore with ID:", docRef.id);

    return {
      statusCode: 200,
      body: JSON.stringify({
        remodelId: docRef.id,
        addressData: addressData[0],
        measurements,
        windowDoorCount,
        materialEstimates,
        costEstimates,
        timelineEstimate,
        roofInfo,
        processedImage,
        satelliteImage,
        satelliteImageError,
      }),
    };
  } catch (error) {
    console.error("Error in remodel:", error.message, error.stack);
    return {
      statusCode: error.message.includes("Invalid address") ? 400 : 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};

async function getBuildingData(lat, lon) {
  console.log("Fetching building data...");

  const overpassQuery = `
    [out:json];
    way["building"](around:50,${lat},${lon});
    out body;
    >;
    out skel qt;
  `;
  const overpassResponse = await fetch(
    `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(overpassQuery)}`
  );
  const overpassData = await overpassResponse.json();

  if (!overpassData.elements.length) {
    console.log("No building found, using fallback dimensions");
    return {
      measurements: { width: 50, length: 30, area: 1500 },
      roofInfo: { pitch: "6/12", height: 20, roofArea: 1650, roofMaterial: "Asphalt Shingles" },
    };
  }

  const building = overpassData.elements.find(elem => elem.type === "way");
  if (!building) {
    return {
      measurements: { width: 50, length: 30, area: 1500 },
      roofInfo: { pitch: "6/12", height: 20, roofArea: 1650, roofMaterial: "Asphalt Shingles" },
    };
  }

  const nodes = building.nodes.map(nodeId =>
    overpassData.elements.find(elem => elem.id === nodeId && elem.type === "node")
  );

  const lats = nodes.map(node => node.lat);
  const lons = nodes.map(node => node.lon);
  const latDiff = Math.max(...lats) - Math.min(...lats);
  const lonDiff = Math.max(...lons) - Math.min(...lons);

  const latFeet = latDiff * 364320;
  const lonFeet = lonDiff * 364320 * Math.cos((lat * Math.PI) / 180);

  const width = Math.round(Math.max(latFeet, lonFeet));
  const length = Math.round(Math.min(latFeet, lonFeet));
  const area = width * length;

  const pitch = "6/12";
  const pitchFactor = 1.118;
  const roofArea = area * pitchFactor;
  const roofMaterial = "Asphalt Shingles";

  const baseHeight = building.tags?.levels ? parseInt(building.tags.levels) * 10 : 10;
  const roofHeight = (width / 2) * (6 / 12);
  const totalHeight = baseHeight + roofHeight;

  return {
    measurements: { width, length, area },
    roofInfo: { pitch, height: Math.round(totalHeight), roofArea: Math.round(roofArea), roofMaterial },
  };
}

async function analyzePhotos(images) {
  console.log("Analyzing photos for windows and doors...");
  if (!images || images.length === 0) {
    console.log("No images provided, using default counts");
    return { windows: 0, doors: 0, windowSizes: [], doorSizes: [], image: null };
  }

  const CLARIFAI_API_KEY = process.env.CLARIFAI_API_KEY;
  if (!CLARIFAI_API_KEY) {
    console.error("Clarifai API key missing, using fallback");
    return {
      windows: images.length * 4,
      doors: images.length * 2,
      windowSizes: Array(images.length * 4).fill("3ft x 4ft"),
      doorSizes: Array(images.length * 2).fill("3ft x 7ft"),
      image: null,
    };
  }

  try {
    let windowCount = 0;
    let doorCount = 0;
    let windowSizes = [];
    let doorSizes = [];
    let firstValidImage = null;

    const photosToProcess = images.slice(0, 1);
    console.log(`Processing ${photosToProcess.length} photo (limited to 1 for free-tier)`);

    for (const [index, image] of photosToProcess.entries()) {
      console.log(`Processing photo ${index + 1}/${photosToProcess.length}`);

      if (typeof image !== "string" || !image.startsWith("data:image/")) {
        console.error(`Invalid image data for photo ${index + 1}, skipping:`, image);
        continue;
      }

      const base64Image = image.split(",")[1];
      if (!base64Image) {
        console.error(`Failed to extract base64 data from photo ${index + 1}, skipping`);
        continue;
      }

      if (!firstValidImage) {
        firstValidImage = image;
        console.log("First valid image captured for response");
      }

      const response = await fetch(
        "https://api.clarifai.com/v2/models/general-image-recognition/outputs",
        {
          method: "POST",
          headers: {
            Authorization: `Key ${CLARIFAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            inputs: [{ data: { image: { base64: base64Image } } }],
          }),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Clarifai API error for photo ${index + 1}: ${response.status} - ${errorText}`);
        continue;
      }

      let data;
      try {
        data = await response.json();
      } catch (jsonError) {
        console.error(`Failed to parse Clarifai response for photo ${index + 1}:`, jsonError.message);
        continue;
      }

      if (!data.outputs || !data.outputs[0] || !data.outputs[0].data || !data.outputs[0].data.concepts) {
        console.error(`Unexpected Clarifai response structure for photo ${index + 1}:`, JSON.stringify(data));
        continue;
      }

      data.outputs[0].data.concepts.forEach(concept => {
        if (concept.name.toLowerCase().includes("window")) {
          windowCount++;
          const size = concept.value > 0.9 ? "4ft x 5ft" : "3ft x 4ft";
          windowSizes.push(size);
        }
        if (concept.name.toLowerCase().includes("door")) {
          doorCount++;
          const size = concept.value > 0.9 ? "3ft x 8ft" : "3ft x 7ft";
          doorSizes.push(size);
        }
      });
    }

    console.log(`Detected ${windowCount} windows and ${doorCount} doors`);
    return {
      windows: windowCount,
      doors: doorCount,
      windowSizes,
      doorSizes,
      image: firstValidImage,
    };
  } catch (error) {
    console.error("Error analyzing photos:", error.message, error.stack);
    return {
      windows: images.length * 4,
      doors: images.length * 2,
      windowSizes: Array(images.length * 4).fill("3ft x 4ft"),
      doorSizes: Array(images.length * 2).fill("3ft x 7ft"),
      image: null,
    };
  }
}

function calculateMaterialEstimates(measurements, windowDoorCount, roofInfo) {
  console.log("Calculating material estimates...");
  const { area } = measurements;
  const { windows, doors, windowSizes, doorSizes } = windowDoorCount;
  const { roofArea, roofMaterial } = roofInfo;

  const sidingArea = area * 1.1;
  const siding = `Siding: ${Math.round(sidingArea)} sq ft`;

  const paintGallons = Math.ceil((area * 2) / 400);
  const paint = `Exterior Paint: ${paintGallons} gallons`;

  const windowEstimates = windowSizes.map((size, index) => `Window ${index + 1}: ${size}`);
  const doorEstimates = doorSizes.map((size, index) => `Door ${index + 1}: ${size}`);

  const roofing = `Roofing (${roofMaterial}): ${Math.round(roofArea)} sq ft`;

  return [siding, paint, ...windowEstimates, ...doorEstimates, roofing];
}

function calculateCostEstimates(materialEstimates, windowDoorCount, area) {
  console.log("Calculating cost estimates...");
  let totalCost = 0;
  const costBreakdown = [];

  materialEstimates.forEach(item => {
    if (item.includes("Siding")) {
      const sidingArea = parseInt(item.match(/\d+/)[0]);
      const cost = sidingArea * 5; // $5 per sq ft
      totalCost += cost;
      costBreakdown.push(`Siding: $${cost} (${sidingArea} sq ft at $5/sq ft)`);
    } else if (item.includes("Exterior Paint")) {
      const gallons = parseInt(item.match(/\d+/)[0]);
      const cost = gallons * 40; // $40 per gallon
      totalCost += cost;
      costBreakdown.push(`Exterior Paint: $${cost} (${gallons} gallons at $40/gallon)`);
    } else if (item.includes("Window")) {
      const size = item.match(/\d+ft x \d+ft/)[0];
      const cost = size === "4ft x 5ft" ? 500 : 300;
      totalCost += cost;
      costBreakdown.push(`${item}: $${cost}`);
    } else if (item.includes("Door")) {
      const size = item.match(/\d+ft x \d+ft/)[0];
      const cost = size === "3ft x 8ft" ? 800 : 600;
      totalCost += cost;
      costBreakdown.push(`${item}: $${cost}`);
    } else if (item.includes("Roofing")) {
      const roofArea = parseInt(item.match(/\d+/)[0]);
      const cost = roofArea * 4; // $4 per sq ft for asphalt shingles
      totalCost += cost;
      costBreakdown.push(`Roofing: $${cost} (${roofArea} sq ft at $4/sq ft)`);
    }
  });

  const laborCost = area * 50; // $50 per sq ft of house area
  totalCost += laborCost;
  costBreakdown.push(`Labor: $${laborCost} (estimated at $50/sq ft for ${area} sq ft)`);

  return { totalCost: Math.round(totalCost), costBreakdown };
}

function calculateTimeline(area, windowDoorCount) {
  console.log("Calculating timeline estimates...");
  let weeks = Math.ceil(area / 500);
  const additionalDays = (windowDoorCount.windows + windowDoorCount.doors);
  weeks += Math.ceil(additionalDays / 5);
  return weeks;
}