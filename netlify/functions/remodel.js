const admin = require("firebase-admin");
const fetch = require("node-fetch");

exports.handler = async (event) => {
  try {
    // Initialize Firebase Admin
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: "turtle-treasure-giveaway",
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
        }),
      });
    }

    const db = admin.firestore();
    const storage = admin.storage();
    const bucket = storage.bucket("turtle-treasure-giveaway.appspot.com");

    // Validate request body
    if (!event.body) {
      throw new Error("Missing request body");
    }

    let body;
    try {
      body = JSON.parse(event.body);
    } catch (parseError) {
      throw new Error("Invalid request body: Failed to parse JSON");
    }

    const { address, photos, windowCount, doorCount, windowSizes, doorSizes } = body;

    if (!address) {
      throw new Error("Missing address in request body");
    }

    if (windowCount === undefined || windowCount < 0) {
      throw new Error("Window count is required and must be 0 or greater");
    }

    if (doorCount === undefined || doorCount < 0) {
      throw new Error("Door count is required and must be 0 or greater");
    }

    // Validate photo arrays
    const directions = ["north", "south", "east", "west"];
    for (const direction of directions) {
      if (photos[direction] && !Array.isArray(photos[direction])) {
        throw new Error(`Invalid photos data for ${direction}: Expected an array`);
      }
    }

    const totalImages = directions
      .flatMap(direction => photos[direction] || [])
      .filter(image => image && typeof image === "string" && image.startsWith("data:image/")).length;

    // Validate address using OpenStreetMap
    const addressResponse = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}`,
      { headers: { "User-Agent": "IndyHomeImprovements/1.0" } }
    );
    if (!addressResponse.ok) {
      throw new Error("Failed to validate address: " + await addressResponse.text());
    }
    const addressData = await addressResponse.json();

    if (!addressData.length) {
      throw new Error("Invalid address: No results found");
    }

    const lat = parseFloat(addressData[0].lat);
    const lon = parseFloat(addressData[0].lon);

    // Get building data using Google Vision API for dimensions if photos are provided
    const buildingData = await getBuildingDataFromUserImages(photos);
    const measurements = buildingData.measurements;
    const roofInfo = buildingData.roofInfo;
    const isMeasurementsReliable = buildingData.isReliable;

    // Use provided window and door counts
    const windowDoorCount = {
      windows: windowCount,
      doors: doorCount,
      windowSizes: windowSizes || [],
      doorSizes: doorSizes || [],
      isReliable: true, // Since counts are provided manually
    };

    // Save images to Firebase Storage if photos are provided
    let processedImages = {};
    let allUploadedImages = {};
    if (totalImages > 0) {
      const imageData = await saveImagesToStorage(photos, bucket);
      processedImages = imageData.processedImages;
      allUploadedImages = imageData.allUploadedImages;
    }

    // Fetch Street View image if no photos are provided
    let streetViewImage = null;
    if (totalImages === 0) {
      const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
      if (GOOGLE_MAPS_API_KEY) {
        // First, check if Street View is available at this location using the Street View Metadata API
        const metadataUrl = `https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lon}&key=${GOOGLE_MAPS_API_KEY}`;
        const metadataResponse = await fetch(metadataUrl);
        if (metadataResponse.ok) {
          const metadata = await metadataResponse.json();
          if (metadata.status === "OK") {
            // Street View is available, fetch the image
            streetViewImage = `https://maps.googleapis.com/maps/api/streetview?size=600x400&location=${lat},${lon}&fov=90&heading=235&pitch=10&key=${GOOGLE_MAPS_API_KEY}`;
          } else {
            console.log(`Backend - Street View not available at ${lat},${lon}:`, metadata.status);
          }
        }
      } else {
        console.warn("Backend - GOOGLE_MAPS_API_KEY not set, skipping Street View image fetch.");
      }
    }

    // Calculate estimates
    const materialEstimates = calculateMaterialEstimates(measurements, windowDoorCount, roofInfo);
    const costEstimates = calculateCostEstimates(materialEstimates, windowDoorCount, measurements.area, addressData);
    const timelineEstimate = calculateTimeline(measurements.area, windowDoorCount);

    console.log("Backend - Material Estimates:", materialEstimates);
    console.log("Backend - Cost Estimates:", costEstimates);
    console.log("Backend - Timeline Estimate:", timelineEstimate);

    // Save to Firestore
    const remodelEntry = {
      address: addressData[0].display_name,
      measurements,
      windowDoorCount,
      materialEstimates,
      costEstimates,
      timelineEstimate,
      roofInfo,
      processedImages,
      allUploadedImages,
      streetViewImage,
      lat,
      lon,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    };

    const docRef = await db.collection("remodels").add(remodelEntry);

    const response = {
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
      allUploadedImages,
      streetViewImage,
      lat,
      lon,
    };

    console.log("Backend - Final Response:", response);
    return {
      statusCode: 200,
      body: JSON.stringify(response),
    };
  } catch (error) {
    console.error("Backend - Handler Error:", error);
    return {
      statusCode: error.message.includes("Invalid address") || error.message.includes("Invalid photos data") ? 400 : 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};

// Helper function to determine location-based cost multiplier
function getLocationMultiplier(addressData) {
  const address = addressData[0]?.display_name?.toLowerCase() || "";
  let multiplierLow = 0.9;
  let multiplierHigh = 1.1;

  if (address.includes("california") || address.includes("new york")) {
    multiplierLow = 1.2;
    multiplierHigh = 1.4;
  } else if (address.includes("indiana") || address.includes("ohio")) {
    multiplierLow = 0.9;
    multiplierHigh = 1.1;
  } else if (address.includes("texas") || address.includes("florida")) {
    multiplierLow = 1.0;
    multiplierHigh = 1.2;
  } else {
    multiplierLow = 0.8;
    multiplierHigh = 0.95;
  }

  console.log(`Backend - Location Multiplier for ${address}: Low=${multiplierLow}, High=${multiplierHigh}`);
  return { multiplierLow, multiplierHigh };
}

async function getBuildingDataFromUserImages(photos) {
  const directions = ["north", "south", "east", "west"];
  let width = 40, length = 32, area = 1280, isReliable = false;
  let pitch = "6/12", height = 16, roofArea = 1431, roofMaterial = "Asphalt Shingles";

  const totalImages = directions
    .flatMap(direction => photos[direction] || [])
    .filter(image => image && typeof image === "string" && image.startsWith("data:image/")).length;

  if (totalImages === 0) {
    // No photos provided, use default dimensions
    const pitchFactor = { "4/12": 1.054, "6/12": 1.118, "8/12": 1.202 }[pitch] || 1.118;
    roofArea = area * pitchFactor;
    const baseHeight = 10;
    const roofHeight = (width / 2) * (parseInt(pitch.split("/")[0]) / 12);
    height = baseHeight + roofHeight;

    return {
      measurements: { width, length, area },
      roofInfo: { pitch, height: Math.round(height), roofArea: Math.round(roofArea), roofMaterial, isPitchReliable: false, pitchSource: "default" },
      isReliable,
    };
  }

  // Use Google Vision API to estimate building dimensions
  let scaleFactor = null;
  for (const direction of directions) {
    const images = photos[direction] || [];
    for (const image of images) {
      try {
        const base64Image = image.split(",")[1];
        const visionResponse = await fetch(
          `https://vision.googleapis.com/v1/images:annotate?key=${process.env.GOOGLE_VISION_API_KEY}`,
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

        if (!visionResponse.ok) continue;

        const visionData = await visionResponse.json();
        const objects = visionData.responses[0]?.localizedObjectAnnotations || [];
        const door = objects.find(obj => obj.name.toLowerCase().includes("door") && obj.score > 0.5);

        if (door) {
          const vertices = door.boundingPoly.normalizedVertices;
          const pixelWidth = Math.abs(vertices[1].x - vertices[0].x) * 600; // Assume 600px image width
          const doorWidthFeet = 3; // Standard door width
          scaleFactor = doorWidthFeet / pixelWidth;
          break;
        }
      } catch (error) {
        console.error(`Backend - Error scaling image in ${direction}:`, error);
      }
    }
    if (scaleFactor) break;
  }

  if (scaleFactor) {
    // Use Google Vision API to detect building footprint
    for (const direction of directions) {
      const images = photos[direction] || [];
      for (const image of images) {
        try {
          const base64Image = image.split(",")[1];
          const visionResponse = await fetch(
            `https://vision.googleapis.com/v1/images:annotate?key=${process.env.GOOGLE_VISION_API_KEY}`,
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

          if (!visionResponse.ok) continue;

          const visionData = await visionResponse.json();
          const objects = visionData.responses[0]?.localizedObjectAnnotations || [];
          const building = objects.find(obj => (obj.name.toLowerCase().includes("house") || obj.name.toLowerCase().includes("building")) && obj.score > 0.5);

          if (building) {
            const vertices = building.boundingPoly.normalizedVertices;
            const pixelArea = Math.abs(vertices[1].x - vertices[0].x) * Math.abs(vertices[2].y - vertices[0].y) * 600 * 600;
            area = Math.round(pixelArea * scaleFactor * scaleFactor);
            width = Math.round(Math.sqrt(area) * 1.25);
            length = Math.round(area / width);
            isReliable = true;

            if (area < 500 || area > 5000) {
              width = 40;
              length = 32;
              area = 1280;
              isReliable = false;
            }
            break;
          }
        } catch (error) {
          console.error(`Backend - Error estimating building dimensions in ${direction}:`, error);
        }
      }
      if (isReliable) break;
    }
  }

  const pitchFactor = { "4/12": 1.054, "6/12": 1.118, "8/12": 1.202 }[pitch] || 1.118;
  roofArea = area * pitchFactor;
  const baseHeight = 10;
  const roofHeight = (width / 2) * (parseInt(pitch.split("/")[0]) / 12);
  height = baseHeight + roofHeight;

  const buildingData = {
    measurements: { width, length, area },
    roofInfo: { pitch, height: Math.round(height), roofArea: Math.round(roofArea), roofMaterial, isPitchReliable: false, pitchSource: "default" },
    isReliable,
  };

  console.log("Backend - Building Data:", buildingData);
  return buildingData;
}

async function saveImagesToStorage(photos, bucket) {
  const directions = ["north", "south", "east", "west"];
  const processedImages = {};
  const allUploadedImages = {};

  for (const direction of directions) {
    const images = photos[direction] || [];
    if (images.length === 0) continue;

    allUploadedImages[direction] = [];
    for (const [index, image] of images.entries()) {
      try {
        const base64Image = image.split(",")[1];
        const imageBuffer = Buffer.from(base64Image, "base64");
        const fileName = `remodels/${Date.now()}_${direction}_${index}.jpg`;
        const file = bucket.file(fileName);
        await file.save(imageBuffer, { metadata: { contentType: "image/jpeg" } });

        const [url] = await file.getSignedUrl({ action: "read", expires: "03-09-2500" });
        allUploadedImages[direction].push(url);
      } catch (error) {
        console.error(`Backend - Error saving image for ${direction}:`, error);
        continue;
      }
    }

    if (allUploadedImages[direction].length > 0) {
      processedImages[direction] = allUploadedImages[direction][0];
    }
  }

  return { processedImages, allUploadedImages };
}

function calculateMaterialEstimates(measurements, windowDoorCount, roofInfo) {
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

function calculateCostEstimates(materialEstimates, windowDoorCount, area, addressData) {
  let totalCostLow = 0;
  let totalCostHigh = 0;
  const costBreakdown = [];

  // Updated cost ranges for 2025 (adjusted for inflation and market trends)
  const costRanges = {
    siding: { materialLow: 7, materialHigh: 12, laborLow: 4, laborHigh: 6 },
    paint: { materialLow: 35, materialHigh: 55, laborLow: 1.5, laborHigh: 3 },
    window: { materialLow: 450, materialHigh: 800, laborLow: 200, laborHigh: 350 },
    door: { materialLow: 900, materialHigh: 1400, laborLow: 300, laborHigh: 500 },
    roofing: { materialLow: 3, materialHigh: 5, laborLow: 2.5, laborHigh: 4 },
  };

  const { multiplierLow, multiplierHigh } = getLocationMultiplier(addressData);

  materialEstimates.forEach(item => {
    try {
      if (item.includes("Siding")) {
        const sidingArea = parseInt(item.match(/\d+/)[0]);
        const materialCostLow = sidingArea * (costRanges.siding?.materialLow || 0) * multiplierLow;
        const materialCostHigh = sidingArea * (costRanges.siding?.materialHigh || 0) * multiplierHigh;
        const laborCostLow = sidingArea * (costRanges.siding?.laborLow || 0) * multiplierLow;
        const laborCostHigh = sidingArea * (costRanges.siding?.laborHigh || 0) * multiplierHigh;
        totalCostLow += materialCostLow + laborCostLow;
        totalCostHigh += materialCostHigh + laborCostHigh;
        costBreakdown.push(
          `Siding Material: $${Math.round(materialCostLow)}–$${Math.round(materialCostHigh)} (${sidingArea} sq ft at $${costRanges.siding?.materialLow || 0}–$${costRanges.siding?.materialHigh || 0}/sq ft)`,
          `Siding Labor: $${Math.round(laborCostLow)}–$${Math.round(laborCostHigh)} (${sidingArea} sq ft at $${costRanges.siding?.laborLow || 0}–$${costRanges.siding?.laborHigh || 0}/sq ft)`
        );
      } else if (item.includes("Exterior Paint")) {
        const gallons = parseInt(item.match(/\d+/)[0]);
        const materialCostLow = gallons * (costRanges.paint?.materialLow || 0) * multiplierLow;
        const materialCostHigh = gallons * (costRanges.paint?.materialHigh || 0) * multiplierHigh;
        const laborCostLow = area * (costRanges.paint?.laborLow || 0) * multiplierLow;
        const laborCostHigh = area * (costRanges.paint?.laborHigh || 0) * multiplierHigh;
        totalCostLow += materialCostLow + laborCostLow;
        totalCostHigh += materialCostHigh + laborCostHigh;
        costBreakdown.push(
          `Exterior Paint Material: $${Math.round(materialCostLow)}–$${Math.round(materialCostHigh)} (${gallons} gallons at $${costRanges.paint?.materialLow || 0}–$${costRanges.paint?.materialHigh || 0}/gallon)`,
          `Exterior Paint Labor: $${Math.round(laborCostLow)}–$${Math.round(laborCostHigh)} (${area} sq ft at $${costRanges.paint?.laborLow || 0}–$${costRanges.paint?.laborHigh || 0}/sq ft)`
        );
      } else if (item.includes("Window")) {
        const materialCostLow = (costRanges.window?.materialLow || 0) * multiplierLow;
        const materialCostHigh = (costRanges.window?.materialHigh || 0) * multiplierHigh;
        const laborCostLow = (costRanges.window?.laborLow || 0) * multiplierLow;
        const laborCostHigh = (costRanges.window?.laborHigh || 0) * multiplierHigh;
        totalCostLow += materialCostLow + laborCostLow;
        totalCostHigh += materialCostHigh + laborCostHigh;
        costBreakdown.push(
          `${item} Material: $${Math.round(materialCostLow)}–$${Math.round(materialCostHigh)}`,
          `${item} Labor: $${Math.round(laborCostLow)}–$${Math.round(laborCostHigh)}`
        );
      } else if (item.includes("Door")) {
        const materialCostLow = (costRanges.door?.materialLow || 0) * multiplierLow;
        const materialCostHigh = (costRanges.door?.materialHigh || 0) * multiplierHigh;
        const laborCostLow = (costRanges.door?.laborLow || 0) * multiplierLow;
        const laborCostHigh = (costRanges.door?.laborHigh || 0) * multiplierHigh;
        totalCostLow += materialCostLow + laborCostLow;
        totalCostHigh += materialCostHigh + laborCostHigh;
        costBreakdown.push(
          `${item} Material: $${Math.round(materialCostLow)}–$${Math.round(materialCostHigh)}`,
          `${item} Labor: $${Math.round(laborCostLow)}–$${Math.round(laborCostHigh)}`
        );
      } else if (item.includes("Roofing")) {
        const roofArea = parseInt(item.match(/\d+/)[0]);
        const materialCostLow = roofArea * (costRanges.roofing?.materialLow || 0) * multiplierLow;
        const materialCostHigh = roofArea * (costRanges.roofing?.materialHigh || 0) * multiplierHigh;
        const laborCostLow = roofArea * (costRanges.roofing?.laborLow || 0) * multiplierLow;
        const laborCostHigh = roofArea * (costRanges.roofing?.laborHigh || 0) * multiplierHigh;
        totalCostLow += materialCostLow + laborCostLow;
        totalCostHigh += materialCostHigh + laborCostHigh;
        costBreakdown.push(
          `Roofing Material: $${Math.round(materialCostLow)}–$${Math.round(materialCostHigh)} (${roofArea} sq ft at $${costRanges.roofing?.materialLow || 0}–$${costRanges.roofing?.materialHigh || 0}/sq ft)`,
          `Roofing Labor: $${Math.round(laborCostLow)}–$${Math.round(laborCostHigh)} (${roofArea} sq ft at $${costRanges.roofing?.laborLow || 0}–$${costRanges.roofing?.laborHigh || 0}/sq ft)`
        );
      }
    } catch (error) {
      console.error(`Backend - Error calculating cost for item "${item}":`, error);
      costBreakdown.push(`Error calculating cost for ${item}: ${error.message}`);
    }
  });

  return { totalCostLow: Math.round(totalCostLow), totalCostHigh: Math.round(totalCostHigh), costBreakdown };
}

function calculateTimeline(area, windowDoorCount) {
  let weeks = Math.ceil(area / 500);
  const additionalDays = (windowDoorCount.windows + windowDoorCount.doors);
  weeks += Math.ceil(additionalDays / 5);
  return weeks;
}