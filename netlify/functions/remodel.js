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
        windows: parseInt(windowCount),
        doors: parseInt(doorCount),
        windowSizes: [],
        doorSizes: [],
        images: {},
        isReliable: true,
      };
    } else {
      const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
      const streetViewData = allImages.length === 0 ? await getStreetViewImages(lat, lon, GOOGLE_MAPS_API_KEY) : { images: {}, status: "not_used" };
      windowDoorInfo = await analyzePhotos(photos, streetViewData.images, bucket);
      windowDoorInfo.streetViewStatus = streetViewData.status;
    }

    const windowDoorCount = {
      windows: windowDoorInfo.windows,
      doors: windowDoorInfo.doors,
      windowSizes: windowDoorInfo.windowSizes,
      doorSizes: windowDoorInfo.doorSizes,
      isReliable: windowDoorInfo.isReliable,
    };
    let processedImages = windowDoorInfo.images;
    console.log("Raw processedImages:", JSON.stringify(processedImages, null, 2));

    const validProcessedImages = {};
    for (const [direction, url] of Object.entries(processedImages)) {
      if (typeof url === "string" && url.startsWith("https://")) {
        validProcessedImages[direction] = url;
      } else {
        console.warn(`Skipping invalid URL for ${direction}:`, url);
      }
    }
    processedImages = validProcessedImages;
    console.log("Validated processedImages:", JSON.stringify(processedImages, null, 2));

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
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    };

    console.log("Saving remodel entry to Firestore:", JSON.stringify(remodelEntry, null, 2));
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
        usedStreetView: allImages.length === 0 && Object.keys(processedImages).length > 0,
        streetViewStatus: windowDoorInfo.streetViewStatus,
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

async function getStreetViewImages(lat, lon, apiKey) {
  console.log("Checking Street View availability...");
  if (!apiKey) {
    console.log("Google Maps API key missing, skipping Street View.");
    return { images: {}, status: "api_key_missing" };
  }

  const directions = ["north", "south", "east", "west"];
  const headings = [0, 180, 90, 270];
  const streetViewImages = {};

  // Check Street View availability using Metadata API
  const metadataUrl = `https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lon}&key=${apiKey}`;
  let metadataResponse;
  try {
    metadataResponse = await fetch(metadataUrl);
    if (!metadataResponse.ok) {
      console.warn("Street View metadata request failed:", metadataResponse.status);
      return { images: {}, status: "metadata_failed" };
    }
    const metadata = await metadataResponse.json();
    if (metadata.status !== "OK") {
      console.warn("Street View not available for this location:", metadata.status);
      return { images: {}, status: "unavailable" };
    }
  } catch (error) {
    console.error("Error checking Street View metadata:", error.message);
    return { images: {}, status: "metadata_error" };
  }

  // Fetch Street View images
  for (let i = 0; i < directions.length; i++) {
    const direction = directions[i];
    const heading = headings[i];
    const url = `https://maps.googleapis.com/maps/api/streetview?size=600x400&location=${lat},${lon}&heading=${heading}&pitch=0&fov=90&key=${apiKey}`;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          console.warn(`Street View unavailable for ${direction} (attempt ${attempt + 1}):`, response.status);
          continue;
        }
        const imageBuffer = await response.buffer();
        const fileName = `remodels/streetview_${Date.now()}_${direction}.jpg`;
        const file = bucket.file(fileName);
        await file.save(imageBuffer, {
          metadata: { contentType: "image/jpeg" },
        });
        console.log(`Street View image uploaded for ${direction}: ${fileName}`);

        const [signedUrl] = await file.getSignedUrl({
          action: "read",
          expires: "03-09-2500",
        });
        streetViewImages[direction] = signedUrl;
        console.log(`Street View URL for ${direction}: ${signedUrl}`);
        break;
      } catch (error) {
        console.error(`Error fetching Street View for ${direction} (attempt ${attempt + 1}):`, error.message);
        if (attempt === 1) {
          console.warn(`Failed to fetch Street View for ${direction} after retries`);
        }
      }
    }
  }

  return {
    images: streetViewImages,
    status: Object.keys(streetViewImages).length > 0 ? "success" : "no_images",
  };
}

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
  let width, length, area;

  if (!overpassData.elements.length) {
    console.log("No building found via Overpass API, using fallback dimensions");
    isReliable = false;
    width = 40;
    length = 32;
    area = 1280; // Adjusted to typical Indianapolis home size
  } else {
    const building = overpassData.elements.find(elem => elem.type === "way");
    if (!building) {
      console.log("No valid building way found, using fallback dimensions");
      isReliable = false;
      width = 40;
      length = 32;
      area = 1280;
    } else {
      const nodes = building.nodes.map(nodeId =>
        overpassData.elements.find(elem => elem.id === nodeId && elem.type === "node")
      );

      const lats = nodes.map(node => node.lat);
      const lons = nodes.map(node => node.lon);
      const latDiff = Math.max(...lats) - Math.min(...lats);
      const lonDiff = Math.max(...lons) - Math.min(...lons);

      const latFeet = latDiff * 364320;
      const lonFeet = lonDiff * 364320 * Math.cos((lat * Math.PI) / 180);

      width = Math.round(Math.max(latFeet, lonFeet));
      length = Math.round(Math.min(latFeet, lonFeet));
      area = width * length;

      if (area < 500 || area > 5000) {
        console.warn(`Unrealistic area from Overpass (${area} sq ft), adjusting to fallback`);
        isReliable = false;
        width = 40;
        length = 32;
        area = 1280;
      }
    }
  }

  const pitch = "6/12"; // Default, updated in getRoofInfo
  const pitchFactor = 1.118;
  const roofArea = area * pitchFactor;
  const roofMaterial = "Asphalt Shingles";

  const baseHeight = 10;
  const roofHeight = (width / 2) * (6 / 12);
  const totalHeight = baseHeight + roofHeight;

  return {
    measurements: { width, length, area },
    roofInfo: { pitch, height: Math.round(totalHeight), roofArea: Math.round(roofArea), roofMaterial },
    isReliable,
  };
}

async function getRoofInfo(lat, lon, baseRoofInfo, apiKey) {
  console.log("Estimating roof info...");
  let { pitch, height, roofArea, roofMaterial } = baseRoofInfo;

  if (!apiKey) {
    console.log("Google Maps API key missing, using default roof info.");
    return { pitch, height, roofArea, roofMaterial, isPitchReliable: false };
  }

  const satelliteUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lon}&zoom=18&size=600x400&maptype=satellite&key=${apiKey}`;
  let imageBuffer;
  try {
    const response = await fetch(satelliteUrl);
    if (!response.ok) {
      console.warn("Failed to fetch satellite image for roof analysis:", response.status);
      return { pitch, height, roofArea, roofMaterial, isPitchReliable: false };
    }
    imageBuffer = await response.buffer();
  } catch (error) {
    console.error("Error fetching satellite image for roof analysis:", error.message);
    return { pitch, height, roofArea, roofMaterial, isPitchReliable: false };
  }

  const GOOGLE_VISION_API_KEY = process.env.GOOGLE_VISION_API_KEY;
  let isPitchReliable = false;
  if (GOOGLE_VISION_API_KEY) {
    try {
      const base64Image = imageBuffer.toString("base64");
      const visionResponse = await fetch(
        `https://vision.googleapis.com/v1/images:annotate?key=${GOOGLE_VISION_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requests: [
              {
                image: { content: base64Image },
                features: [{ type: "OBJECT_LOCALIZATION" }],
              },
            ],
          }),
        }
      );

      if (!visionResponse.ok) {
        console.warn("Google Vision API request failed:", visionResponse.status);
        return { pitch, height, roofArea, roofMaterial, isPitchReliable: false };
      }

      const visionData = await visionResponse.json();
      const objects = visionData.responses[0]?.localizedObjectAnnotations || [];
      const roofDetected = objects.some(obj => obj.name.toLowerCase().includes("roof"));

      if (roofDetected) {
        const steepnessScore = objects.find(obj => obj.name.toLowerCase().includes("roof"))?.score || 0;
        pitch = steepnessScore > 0.7 ? "8/12" : steepnessScore > 0.4 ? "6/12" : "4/12";
        isPitchReliable = true;
        console.log(`Estimated roof pitch using Vision API: ${pitch}`);
      } else {
        console.log("No roof detected in satellite image, using default pitch.");
      }
    } catch (error) {
      console.error("Error using Google Vision API for roof pitch:", error.message);
    }
  }

  return { pitch, height, roofArea, roofMaterial, isPitchReliable };
}

async function analyzePhotos(photos, streetViewImages, bucket) {
  console.log("Analyzing photos for windows and doors...");
  const directions = ["north", "south", "east", "west"];
  const allImages = directions.flatMap(direction => photos[direction] || []);
  console.log(`Received ${allImages.length} user images and ${Object.keys(streetViewImages).length} Street View images`);

  const CLARIFAI_API_KEY = process.env.CLARIFAI_API_KEY;
  if (!CLARIFAI_API_KEY) {
    console.error("Clarifai API key missing, using fallback");
    return {
      windows: (allImages.length + Object.keys(streetViewImages).length) * 2,
      doors: (allImages.length + Object.keys(streetViewImages).length) * 1,
      windowSizes: Array((allImages.length + Object.keys(streetViewImages).length) * 2).fill("3ft x 4ft"),
      doorSizes: Array((allImages.length + Object.keys(streetViewImages).length) * 1).fill("3ft x 7ft"),
      images: streetViewImages,
      isReliable: false,
    };
  }

  let windowCount = 0;
  let doorCount = 0;
  let windowSizes = [];
  let doorSizes = [];
  const processedImages = { ...streetViewImages };
  let isReliable = false;

  // Process user-uploaded images first
  for (const direction of directions) {
    const images = photos[direction] || [];
    if (images.length === 0) continue;

    console.log(`Processing ${images.length} user photos for ${direction} direction`);
    const photosToProcess = images.slice(0, 1);

    for (const [index, image] of photosToProcess.entries()) {
      try {
        console.log(`Processing ${direction} user photo ${index + 1}/${photosToProcess.length}, image data length: ${image?.length || 0}`);

        if (!image || typeof image !== "string" || !image.startsWith("data:image/")) {
          console.error(`Invalid image data for ${direction} photo ${index + 1}:`, image?.substring(0, 50));
          continue;
        }

        const base64Image = image.split(",")[1];
        if (!base64Image) {
          console.error(`Failed to extract base64 data from ${direction} photo ${index + 1}`);
          continue;
        }

        if (base64Image.length > 500000) {
          console.log(`Skipping ${direction} photo ${index + 1}: Image too large (${base64Image.length} bytes)`);
          windowCount += 2;
          doorCount += 1;
          windowSizes.push("3ft x 4ft", "3ft x 4ft");
          doorSizes.push("3ft x 7ft");
          continue;
        }

        const imageBuffer = Buffer.from(base64Image, "base64");
        const fileName = `remodels/${Date.now()}_${direction}_${index}.jpg`;
        const file = bucket.file(fileName);
        await file.save(imageBuffer, {
          metadata: { contentType: "image/jpeg" },
        });
        console.log(`Image uploaded to Firebase Storage: ${fileName}`);

        const [url] = await file.getSignedUrl({
          action: "read",
          expires: "03-09-2500",
        });
        if (url && typeof url === "string" && url.startsWith("https://")) {
          processedImages[direction] = url;
          console.log(`Download URL for ${direction} photo ${index + 1}: ${url}`);
        } else {
          console.warn(`Invalid URL generated for ${direction} photo ${index + 1}:`, url);
          continue;
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

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
          windowCount += 2;
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
          windowCount += 2;
          doorCount += 1;
          windowSizes.push("3ft x 4ft", "3ft x 4ft");
          doorSizes.push("3ft x 7ft");
          continue;
        }

        if (!data.outputs || !data.outputs[0] || !data.outputs[0].data || !data.outputs[0].data.concepts) {
          console.error(`Unexpected Clarifai response structure for ${direction} photo ${index + 1}:`, JSON.stringify(data));
          windowCount += 2;
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
        console.error(`Error processing ${direction} photo ${index + 1}:`, error.message, error.stack);
        windowCount += 2;
        doorCount += 1;
        windowSizes.push("3ft x 4ft", "3ft x 4ft");
        doorSizes.push("3ft x 7ft");
        continue;
      }
    }
  }

  // Process Street View images if no user images
  if (allImages.length === 0) {
    for (const direction of directions) {
      const url = streetViewImages[direction];
      if (!url) continue;

      try {
        console.log(`Processing Street View image for ${direction}`);
        const response = await fetch(url);
        const imageBuffer = await response.buffer();
        const base64Image = imageBuffer.toString("base64");

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        console.log(`Making Clarifai API call for ${direction} Street View`);
        const clarifaiResponse = await fetch(
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

        if (!clarifaiResponse.ok) {
          console.error(`Clarifai API error for ${direction} Street View:`, clarifaiResponse.status);
          windowCount += 2;
          doorCount += 1;
          windowSizes.push("3ft x 4ft", "3ft x 4ft");
          doorSizes.push("3ft x 7ft");
          continue;
        }

        const data = await clarifaiResponse.json();
        if (!data.outputs || !data.outputs[0] || !data.outputs[0].data || !data.outputs[0].data.concepts) {
          console.error(`Unexpected Clarifai response for ${direction} Street View`);
          windowCount += 2;
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
        console.log(`${direction} Street View processed: ${windowCount} windows, ${doorCount} doors detected so far`);
      } catch (error) {
        console.error(`Error processing ${direction} Street View:`, error.message);
        windowCount += 2;
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