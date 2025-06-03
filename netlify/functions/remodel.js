const admin = require("firebase-admin");

exports.handler = async (event) => {
  try {
    // Initialize Firebase Admin if not already initialized
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

    // Handle GET request for API key
    if (event.httpMethod === "GET" && event.queryStringParameters?.action === "get-api-key") {
      const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
      if (!GOOGLE_MAPS_API_KEY) {
        console.error("Backend - GOOGLE_MAPS_API_KEY not found in environment variables");
        return {
          statusCode: 500,
          body: JSON.stringify({ error: "API key not configured on the server" }),
        };
      }
      console.log("Backend - Successfully retrieved Google Maps API key for frontend");
      return {
        statusCode: 200,
        body: JSON.stringify({ apiKey: GOOGLE_MAPS_API_KEY }),
      };
    }

    // Existing logic for remodel estimate (POST request)
    if (event.httpMethod !== "POST") {
      throw new Error("Method not allowed. Use POST for remodel estimates or GET with action=get-api-key for API key.");
    }

    if (!event.body) {
      throw new Error("Missing request body");
    }

    let body;
    try {
      body = JSON.parse(event.body);
    } catch (parseError) {
      throw new Error("Invalid request body: Failed to parse JSON");
    }

    const { address, components, photos, windowCount, doorCount, userPin } = body;

    if (!address) {
      throw new Error("Missing address in request body");
    }

    if (!Array.isArray(components) || components.length === 0) {
      throw new Error("Components must be a non-empty array (e.g., ['roof', 'windows', 'doors', 'siding'])");
    }

    const validComponents = ["roof", "windows", "doors", "siding"];
    if (!components.every(comp => validComponents.includes(comp))) {
      throw new Error("Invalid component(s) provided. Must be one or more of: roof, windows, doors, siding");
    }

    if (components.includes("windows") && (windowCount === undefined || windowCount < 0)) {
      throw new Error("Window count is required and must be 0 or greater when estimating windows");
    }

    if (components.includes("doors") && (doorCount === undefined || doorCount < 0)) {
      throw new Error("Door count is required and must be 0 or greater when estimating doors");
    }

    const directions = ["north", "south", "east", "west"];
    for (const direction of directions) {
      if (photos[direction] && !Array.isArray(photos[direction])) {
        throw new Error(`Invalid photos data for ${direction}: Expected an array`);
      }
    }

    const totalImages = directions
      .flatMap(direction => photos[direction] || [])
      .filter(image => image && typeof image === "string" && image.startsWith("data:image/")).length;

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

    let lat = parseFloat(addressData[0].lat);
    let lon = parseFloat(addressData[0].lon);

    if (userPin && typeof userPin.lat === "number" && typeof userPin.lng === "number") {
      const userLat = userPin.lat;
      const userLng = userPin.lng;
      const distance = Math.sqrt(Math.pow(userLat - lat, 2) + Math.pow(userLng - lon, 2));
      if (distance < 0.01) {
        lat = userLat;
        lon = userLng;
        console.log(`Backend - Using user-provided coordinates: lat=${lat}, lon=${lon}`);
      } else {
        console.warn(`Backend - User-provided coordinates too far from address coordinates, using address coordinates instead`);
      }
    }

    const buildingData = await getBuildingDataFromUserImages(photos, lat, lon, addressData, !!userPin);
    const measurements = buildingData.measurements;
    const roofInfo = buildingData.roofInfo;
    const isMeasurementsReliable = buildingData.isReliable;

    const windowDoorCount = {
      windows: components.includes("windows") ? windowCount : 0,
      doors: components.includes("doors") ? doorCount : 0,
      isReliable: true,
    };

    let processedImages = {};
    let allUploadedImages = {};
    if (totalImages > 0) {
      const imageData = await saveImagesToStorage(photos, bucket);
      processedImages = imageData.processedImages;
      allUploadedImages = imageData.allUploadedImages;
    }

    let satelliteViewImage = null;
    if (totalImages === 0) {
      const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
      if (GOOGLE_MAPS_API_KEY) {
        const zoomLevel = userPin ? 20 : 19;
        satelliteViewImage = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lon}&zoom=${zoomLevel}&size=800x600&maptype=satellite&key=${GOOGLE_MAPS_API_KEY}`;
        console.log(`Backend - Fetched satellite view image for ${lat},${lon} at zoom level ${zoomLevel}`);
      } else {
        console.warn("Backend - GOOGLE_MAPS_API_KEY not set, skipping satellite view image fetch.");
      }
    }

    const materialEstimates = calculateMaterialEstimates(measurements, windowDoorCount, roofInfo, components);
    const costEstimates = calculateCostEstimates(materialEstimates, windowDoorCount, measurements.area, addressData, components);
    const timelineEstimate = calculateTimeline(measurements.area, windowDoorCount, components);

    console.log("Backend - Material Estimates:", materialEstimates);
    console.log("Backend - Cost Estimates:", costEstimates);
    console.log("Backend - Timeline Estimate:", timelineEstimate);

    const remodelEntry = {
      address: addressData[0].display_name,
      components,
      measurements,
      windowDoorCount,
      materialEstimates,
      costEstimates,
      timelineEstimate,
      roofInfo,
      processedImages,
      allUploadedImages,
      satelliteViewImage,
      lat,
      lon,
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
      satelliteViewImage,
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

function getAverageHomeSize(addressData) {
  const address = addressData[0]?.display_name?.toLowerCase() || "";
  let averageArea = 1500;

  if (address.includes("california") || address.includes("new york")) {
    averageArea = 1800;
  } else if (address.includes("indiana") || address.includes("ohio")) {
    averageArea = 1400;
  } else if (address.includes("texas") || address.includes("florida")) {
    averageArea = 1600;
  }

  console.log(`Backend - Estimated average home size for ${address}: ${averageArea} sqft`);
  return averageArea;
}

function calculateMetersPerPixel(latitude, zoom) {
  const metersPerPixel = (156543.03392 * Math.cos(latitude * Math.PI / 180)) / Math.pow(2, zoom);
  console.log(`Backend - Calculated meters per pixel at latitude ${latitude}, zoom ${zoom}: ${metersPerPixel}`);
  return metersPerPixel;
}

async function getBuildingDataFromUserImages(photos, lat, lon, addressData, hasUserPin) {
  const directions = ["north", "south", "east", "west"];
  let width, length, area, isReliable = false;
  let pitch = "6/12", height = 16, roofArea, roofMaterial = "Asphalt Shingles";

  const totalImages = directions
    .flatMap(direction => photos[direction] || [])
    .filter(image => image && typeof image === "string" && image.startsWith("data:image/")).length;

  if (totalImages === 0) {
    const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
    if (GOOGLE_MAPS_API_KEY) {
      console.log(`Backend - Attempting to estimate area using satellite imagery for ${lat},${lon}`);
      const zoomLevel = hasUserPin ? 20 : 19;
      const satelliteImageUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lon}&zoom=${zoomLevel}&size=800x600&maptype=satellite&key=${GOOGLE_MAPS_API_KEY}`;

      const imageResponse = await fetch(satelliteImageUrl);
      if (!imageResponse.ok) {
        console.warn(`Backend - Failed to fetch satellite image: ${imageResponse.statusText}`);
        area = getAverageHomeSize(addressData);
        width = Math.round(Math.sqrt(area) * 1.25);
        length = Math.round(area / width);
      } else {
        const imageBuffer = await imageResponse.arrayBuffer();
        const base64Image = Buffer.from(imageBuffer).toString("base64");

        const visionResponse = await fetch(
          `https://vision.googleapis.com/v1/images:annotate?key=${process.env.GOOGLE_VISION_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              requests: [
                {
                  image: { content: base64Image },
                  features: [
                    { type: "OBJECT_LOCALIZATION" },
                    { type: "IMAGE_PROPERTIES" },
                  ],
                },
              ],
            }),
          }
        );

        if (!visionResponse.ok) {
          console.warn(`Backend - Vision API failed: ${await visionResponse.text()}`);
          area = getAverageHomeSize(addressData);
          width = Math.round(Math.sqrt(area) * 1.25);
          length = Math.round(area / width);
        } else {
          const visionData = await visionResponse.json();
          console.log("Backend - Vision API Response:", visionData);

          const objects = visionData.responses[0]?.localizedObjectAnnotations || [];
          let building = objects.find(obj => (obj.name.toLowerCase().includes("house") || obj.name.toLowerCase().includes("building")) && obj.score > 0.3);

          if (building) {
            console.log(`Backend - Building detected with confidence ${building.score}`);
            const vertices = building.boundingPoly.normalizedVertices;
            const pixelWidth = Math.abs(vertices[1].x - vertices[0].x) * 800;
            const pixelHeight = Math.abs(vertices[2].y - vertices[0].y) * 600;
            const pixelArea = pixelWidth * pixelHeight;

            const metersPerPixel = calculateMetersPerPixel(lat, zoomLevel);
            const areaMeters = pixelArea * metersPerPixel * metersPerPixel;
            area = Math.round(areaMeters * 10.7639);

            if (area < 500 || area > 5000) {
              console.warn(`Backend - Estimated area ${area} sqft out of bounds, using regional average`);
              area = getAverageHomeSize(addressData);
              isReliable = false;
            } else {
              isReliable = true;
            }

            width = Math.round(Math.sqrt(area) * 1.25);
            length = Math.round(area / width);
            console.log(`Backend - Satellite image analysis (Object Localization) estimated area: ${area} sqft`);
          } else {
            console.log("Backend - No building detected, attempting color-based roof detection");
            const imageProperties = visionData.responses[0]?.imagePropertiesAnnotation;
            if (imageProperties && imageProperties.dominantColors && imageProperties.dominantColors.colors) {
              const roofColor = imageProperties.dominantColors.colors.find(color => {
                const rgb = color.color;
                return rgb.red < 150 && rgb.green < 150 && rgb.blue < 150 && color.score > 0.2;
              });

              if (roofColor) {
                console.log(`Backend - Potential roof color detected:`, roofColor);
                const pixelArea = 800 * 600 * roofColor.pixelFraction;
                const metersPerPixel = calculateMetersPerPixel(lat, zoomLevel);
                const areaMeters = pixelArea * metersPerPixel * metersPerPixel;
                area = Math.round(areaMeters * 10.7639);

                if (area < 500 || area > 5000) {
                  console.warn(`Backend - Estimated area ${area} sqft out of bounds, using regional average`);
                  area = getAverageHomeSize(addressData);
                  isReliable = false;
                } else {
                  isReliable = true;
                }

                width = Math.round(Math.sqrt(area) * 1.25);
                length = Math.round(area / width);
                console.log(`Backend - Satellite image analysis (Color Detection) estimated area: ${area} sqft`);
              } else {
                console.warn("Backend - No suitable roof color detected, using regional average");
                area = getAverageHomeSize(addressData);
                width = Math.round(Math.sqrt(area) * 1.25);
                length = Math.round(area / width);
              }
            } else {
              console.warn("Backend - No image properties data, using regional average");
              area = getAverageHomeSize(addressData);
              width = Math.round(Math.sqrt(area) * 1.25);
              length = Math.round(area / width);
            }
          }
        }
      }
    } else {
      console.warn("Backend - GOOGLE_MAPS_API_KEY not set, using default area estimate.");
      area = getAverageHomeSize(addressData);
      width = Math.round(Math.sqrt(area) * 1.25);
      length = Math.round(area / width);
    }

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
          const pixelWidth = Math.abs(vertices[1].x - vertices[0].x) * 600;
          const doorWidthFeet = 3;
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
              area = getAverageHomeSize(addressData);
              width = Math.round(Math.sqrt(area) * 1.25);
              length = Math.round(area / width);
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

  if (!area) {
    area = getAverageHomeSize(addressData);
    width = Math.round(Math.sqrt(area) * 1.25);
    length = Math.round(area / width);
    isReliable = false;
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

        const expirationDate = new Date("2026-06-02");
        const [url] = await file.getSignedUrl({ action: "read", expires: expirationDate });
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

function calculateMaterialEstimates(measurements, windowDoorCount, roofInfo, components) {
  const { area } = measurements;
  const { windows, doors } = windowDoorCount;
  const { roofArea, roofMaterial } = roofInfo;

  const materialEstimates = [];

  if (components.includes("siding")) {
    const perimeter = 2 * (measurements.width + measurements.length);
    const sidingArea = perimeter * 10 * 1.1;
    materialEstimates.push(`Siding: ${Math.round(sidingArea)} sq ft`);
  }

  if (components.includes("windows")) {
    for (let i = 0; i < windows; i++) {
      materialEstimates.push(`Window ${i + 1}`);
    }
  }

  if (components.includes("doors")) {
    for (let i = 0; i < doors; i++) {
      materialEstimates.push(`Door ${i + 1}`);
    }
  }

  if (components.includes("roof")) {
    materialEstimates.push(`Roofing (${roofMaterial}): ${Math.round(roofArea)} sq ft`);
  }

  return materialEstimates.length > 0 ? materialEstimates : ["No materials estimated for the selected components"];
}

function calculateCostEstimates(materialEstimates, windowDoorCount, area, addressData, components) {
  let totalCostLow = 0;
  let totalCostHigh = 0;
  const costBreakdown = [];

  const costRanges = {
    siding: { materialLow: 8, materialHigh: 14, laborLow: 5, laborHigh: 7 },
    window: { materialLow: 500, materialHigh: 900, laborLow: 250, laborHigh: 400 },
    door: { materialLow: 1300, materialHigh: 5500, laborLow: 450, laborHigh: 1300 },
    roofing: { materialLow: 4, materialHigh: 6, laborLow: 3, laborHigh: 5 },
  };

  const { multiplierLow, multiplierHigh } = getLocationMultiplier(addressData);

  materialEstimates.forEach(item => {
    try {
      if (item.includes("Siding") && components.includes("siding")) {
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
      } else if (item.includes("Window") && components.includes("windows")) {
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
      } else if (item.includes("Door") && components.includes("doors")) {
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
      } else if (item.includes("Roofing") && components.includes("roof")) {
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

function calculateTimeline(area, windowDoorCount, components) {
  let weeks = 0;
  const { windows, doors } = windowDoorCount;

  if (components.includes("siding")) {
    weeks += Math.ceil(area / 500);
  }

  if (components.includes("roof")) {
    weeks += Math.ceil(area / 500);
  }

  if (components.includes("windows") || components.includes("doors")) {
    const additionalDays = (windows + doors);
    weeks += Math.ceil(additionalDays / 5);
  }

  return Math.max(weeks, 1);
}
