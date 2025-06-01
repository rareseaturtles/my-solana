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
      .filter(image => image && typeof image === "string");
    console.log(`Processing remodel for address: ${address}, total images received: ${allImages.length}`);

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
    const isMeasurementsReliable = buildingData.isReliable;

    const windowDoorInfo = windowCount && doorCount
      ? { windows: parseInt(windowCount), doors: parseInt(doorCount), windowSizes: [], doorSizes: [], images: {}, isReliable: true }
      : await analyzePhotos(photos);

    const windowDoorCount = {
      windows: windowDoorInfo.windows,
      doors: windowDoorInfo.doors,
      windowSizes: windowDoorInfo.windowSizes,
      doorSizes: windowDoorInfo.doorSizes,
      isReliable: windowDoorInfo.isReliable,
    };
    const processedImages = windowDoorInfo.images;
    console.log("Processed images included in response:", Object.keys(processedImages).length > 0);

    const materialEstimates = calculateMaterialEstimates(measurements, windowDoorCount, roofInfo);

    const costEstimates = calculateCostEstimates(materialEstimates, windowDoorCount, measurements.area);
    const timelineEstimate = calculateTimeline(measurements.area, windowDoorCount);

    const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
    console.log("Google Maps API key retrieved:", GOOGLE_MAPS_API_KEY ? "Present" : "Missing");
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
      costEstimates,
      timelineEstimate,
      roofInfo,
      processedImages,
      satelliteImage,
      satelliteImageError,
      lat,
      lon,
      googleMapsApiKey: GOOGLE_MAPS_API_KEY,
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
        isMeasurementsReliable,
        windowDoorCount,
        materialEstimates,
        costEstimates,
        timelineEstimate,
        roofInfo,
        processedImages,
        satelliteImage,
        satelliteImageError,
        googleMapsApiKey: GOOGLE_MAPS_API_KEY,
      }),
    };
  } catch (error) {
    console.error("Error in remodel:", error.message, error.stack);
    return {
      statusCode: error.message.includes("Invalid address") || error.message.includes("Invalid photos data") ? 400 : 500,
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

  let isReliable = true;

  if (!overpassData.elements.length) {
    console.log("No building found, using fallback dimensions");
    isReliable = false;
    return {
      measurements: { width: 50, length: 30, area: 1500 },
      roofInfo: { pitch: "6/12", height: 20, roofArea: 1650, roofMaterial: "Asphalt Shingles" },
      isReliable,
    };
  }

  const building = overpassData.elements.find(elem => elem.type === "way");
  if (!building) {
    isReliable = false;
    return {
      measurements: { width: 50, length: 30, area: 1500 },
      roofInfo: { pitch: "6/12", height: 20, roofArea: 1650, roofMaterial: "Asphalt Shingles" },
      isReliable,
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
    isReliable,
  };
}

async function analyzePhotos(photos) {
  console.log("Analyzing photos for windows and doors...");
  if (!photos || Object.keys(photos).length === 0) {
    console.log("No photos provided, using default counts");
    return { windows: 0, doors: 0, windowSizes: [], doorSizes: [], images: {}, isReliable: false };
  }

  const directions = ["north", "south", "east", "west"];
  const allImages = directions.flatMap(direction => photos[direction] || []);
  console.log(`Received ${allImages.length} images across all directions`);

  const CLARIFAI_API_KEY = process.env.CLARIFAI_API_KEY;
  if (!CLARIFAI_API_KEY) {
    console.error("Clarifai API key missing, using fallback");
    return {
      windows: allImages.length * 2,
      doors: allImages.length * 1,
      windowSizes: Array(allImages.length * 2).fill("3ft x 4ft"),
      doorSizes: Array(allImages.length * 1).fill("3ft x 7ft"),
      images: {},
      isReliable: false,
    };
  }

  let windowCount = 0;
  let doorCount = 0;
  let windowSizes = [];
  let doorSizes = [];
  const processedImages = {};
  let isReliable = false;

  // Process only 1 image per direction to minimize API calls and prevent timeouts
  for (const direction of directions) {
    const images = photos[direction] || [];
    if (images.length === 0) continue;

    console.log(`Processing ${images.length} photos for ${direction} direction`);
    const photosToProcess = images.slice(0, 1); // Limit to 1 per direction to reduce load

    for (const [index, image] of photosToProcess.entries()) {
      try {
        console.log(`Processing ${direction} photo ${index + 1}/${photosToProcess.length}, image data length: ${image?.length || 0}`);

        if (!image || typeof image !== "string") {
          console.error(`Invalid image data for ${direction} photo ${index + 1}: Image is null or not a string`);
          continue;
        }

        if (!image.startsWith("data:image/")) {
          console.error(`Invalid image format for ${direction} photo ${index + 1}:`, image.substring(0, 50));
          continue;
        }

        const base64Image = image.split(",")[1];
        if (!base64Image) {
          console.error(`Failed to extract base64 data from ${direction} photo ${index + 1}`);
          continue;
        }

        // Skip large images to reduce load
        if (base64Image.length > 500000) { // ~500KB
          console.log(`Skipping ${direction} photo ${index + 1}: Image too large (${base64Image.length} bytes)`);
          windowCount += 2; // Fallback for skipped image
          doorCount += 1;
          windowSizes.push("3ft x 4ft", "3ft x 4ft");
          doorSizes.push("3ft x 7ft");
          if (!processedImages[direction]) {
            processedImages[direction] = image;
          }
          continue;
        }

        if (!processedImages[direction]) {
          processedImages[direction] = image;
          console.log(`First valid image captured for ${direction} direction`);
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000); // 3-second timeout

        console.log(`Making Clarifai API call for ${direction} photo ${index + 1}`);
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
            signal: controller.signal,
          }
        );

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorText = await response.text();
          console.error(`Clarifai API error for ${direction} photo ${index + 1}: ${response.status} - ${errorText}`);
          windowCount += 2; // Fallback on error
          doorCount += 1;
          windowSizes.push("3ft x 4ft", "3ft x 4ft");
          doorSizes.push("3ft x 7ft");
          continue;
        }

        let data;
        try {
          data = await response.json();
        } catch (jsonError) {
          console.error(`Failed to parse Clarifai response for ${direction} photo ${index + 1}:`, jsonError.message);
          windowCount += 2; // Fallback on parse error
          doorCount += 1;
          windowSizes.push("3ft x 4ft", "3ft x 4ft");
          doorSizes.push("3ft x 7ft");
          continue;
        }

        if (!data.outputs || !data.outputs[0] || !data.outputs[0].data || !data.outputs[0].data.concepts) {
          console.error(`Unexpected Clarifai response structure for ${direction} photo ${index + 1}:`, JSON.stringify(data));
          windowCount += 2; // Fallback on invalid response
          doorCount += 1;
          windowSizes.push("3ft x 4ft", "3ft x 4ft");
          doorSizes.push("3ft x 7ft");
          continue;
        }

        isReliable = true;
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
        console.log(`${direction} photo ${index + 1} processed: ${windowCount} windows, ${doorCount} doors detected so far`);
      } catch (error) {
        if (error.name === "AbortError") {
          console.error(`Clarifai API call timed out for ${direction} photo ${index + 1}`);
        } else {
          console.error(`Error processing ${direction} photo ${index + 1}:`, error.message, error.stack);
        }
        windowCount += 2; // Fallback on any error
        doorCount += 1;
        windowSizes.push("3ft x 4ft", "3ft x 4ft");
        doorSizes.push("3ft x 7ft");
        continue;
      }
    }
  }

  console.log(`Total detected: ${windowCount} windows and ${doorCount} doors`);
  return {
    windows: windowCount,
    doors: doorCount,
    windowSizes,
    doorSizes,
    images: processedImages,
    isReliable,
  };
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
      const cost = sidingArea * 5;
      totalCost += cost;
      costBreakdown.push(`Siding: $${cost} (${sidingArea} sq ft at $5/sq ft)`);
    } else if (item.includes("Exterior Paint")) {
      const gallons = parseInt(item.match(/\d+/)[0]);
      const cost = gallons * 40;
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
      const cost = roofArea * 4;
      totalCost += cost;
      costBreakdown.push(`Roofing: $${cost} (${roofArea} sq ft at $4/sq ft)`);
    }
  });

  const laborCost = area * 50;
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