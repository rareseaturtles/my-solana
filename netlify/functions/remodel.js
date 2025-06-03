const admin = require("firebase-admin");
const fetch = require("node-fetch");
const cv = require("opencv4nodejs");

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

    const { address, photos, retryPhotos, windowCount, doorCount, windowSizes, doorSizes } = body;

    if (!address) {
      throw new Error("Missing address in request body");
    }

    // Validate photo arrays
    const directions = ["north", "south", "east", "west"];
    for (const direction of directions) {
      if (photos[direction] && !Array.isArray(photos[direction])) {
        throw new Error(`Invalid photos data for ${direction}: Expected an array`);
      }
      if (retryPhotos && retryPhotos[direction] && !Array.isArray(retryPhotos[direction])) {
        throw new Error(`Invalid retry photos data for ${direction}: Expected an array`);
      }
    }

    const allImages = directions
      .flatMap(direction => photos[direction] || [])
      .filter(image => image && typeof image === "string" && image.startsWith("data:image/"));
    const allRetryImages = directions
      .flatMap(direction => (retryPhotos && retryPhotos[direction]) || [])
      .filter(image => image && typeof image === "string" && image.startsWith("data:image/"));

    if (allImages.length < 4 && allRetryImages.length < 4 && windowCount === null && doorCount === null) {
      throw new Error("Please upload at least one photo for each direction (north, south, east, west) or provide window and door counts");
    }

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

    // Get building data from user images
    const buildingData = await getBuildingDataFromUserImages(photos, retryPhotos, bucket);
    const measurements = buildingData.measurements;
    const roofInfo = buildingData.roofInfo;
    const isMeasurementsReliable = buildingData.isReliable;

    // Analyze windows and doors
    let windowDoorInfo;
    if (windowCount !== null && doorCount !== null && windowSizes && doorSizes) {
      windowDoorInfo = {
        windows: windowCount,
        doors: doorCount,
        windowSizes: windowSizes,
        doorSizes: doorSizes,
        images: {},
        allUploadedImages: {},
        isReliable: true,
      };
    } else {
      windowDoorInfo = await analyzePhotosWithGoogleVision(photos, retryPhotos, bucket);
      const retryDirections = windowDoorInfo.retryDirections || [];
      if (retryDirections.length > 0) {
        return {
          statusCode: 200,
          body: JSON.stringify({ retryDirections }),
        };
      }

      if (!windowDoorInfo.isReliable && (!windowSizes || !doorSizes)) {
        throw new Error("Failed to detect windows or doors, and no manual sizes provided. Please provide manual counts and sizes.");
      }

      if (windowSizes && doorSizes) {
        windowDoorInfo.windowSizes = windowSizes;
        windowDoorInfo.doorSizes = doorSizes;
        windowDoorInfo.isReliable = true;
      }
    }

    const windowDoorCount = {
      windows: windowDoorInfo.windows,
      doors: windowDoorInfo.doors,
      windowSizes: windowDoorInfo.windowSizes,
      doorSizes: windowDoorInfo.doorSizes,
      isReliable: windowDoorInfo.isReliable,
    };
    let processedImages = windowDoorInfo.images || {};
    const allUploadedImages = windowDoorInfo.allUploadedImages || {};

    // Clean up undefined processed images
    for (const direction of directions) {
      if (processedImages[direction] === undefined) {
        delete processedImages[direction];
      }
    }

    // Calculate estimates
    const materialEstimates = calculateMaterialEstimates(measurements, windowDoorCount, roofInfo);
    const costEstimates = calculateCostEstimates(materialEstimates, windowDoorCount, measurements.area, addressData);
    const timelineEstimate = calculateTimeline(measurements.area, windowDoorCount);

    console.log("Calculated cost estimates:", costEstimates); // Debug log

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
      lat,
      lon,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    };

    const docRef = await db.collection("remodels").add(remodelEntry);

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
        allUploadedImages,
      }),
    };
  } catch (error) {
    console.error("Handler error:", error);
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

  console.log(`Location multiplier for ${address}: Low=${multiplierLow}, High=${multiplierHigh}`); // Debug log
  return { multiplierLow, multiplierHigh };
}

async function getBuildingDataFromUserImages(photos, retryPhotos, bucket) {
  const directions = ["north", "south", "east", "west"];
  let width = 40, length = 32, area = 1280, isReliable = false;
  let pitch = "6/12", height = 16, roofArea = 1431, roofMaterial = "Asphalt Shingles";

  let roofImage = null;
  for (const direction of directions) {
    const images = (retryPhotos && retryPhotos[direction] && retryPhotos[direction].length > 0) ? retryPhotos[direction] : photos[direction] || [];
    for (const image of images) {
      try {
        const base64Image = image.split(",")[1];
        const img = cv.imdecode(Buffer.from(base64Image, "base64"));
        const gray = img.cvtColor(cv.COLOR_BGR2GRAY);
        const edges = gray.canny(50, 150);
        const contours = edges.findContours(cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

        let roofDetected = false;
        let maxArea = 0;
        let roofContour = null;
        for (const contour of contours) {
          const area = contour.area;
          if (area > maxArea && area > 1000) {
            maxArea = area;
            roofContour = contour;
            roofDetected = true;
          }
        }

        if (roofDetected) {
          roofImage = { image, contour: roofContour, direction };
          break;
        }
      } catch (error) {
        console.error(`Error processing image for roof detection in ${direction}:`, error);
      }
    }
    if (roofImage) break;
  }

  if (roofImage) {
    let scaleFactor = null;
    for (const direction of directions) {
      const images = (retryPhotos && retryPhotos[direction] && retryPhotos[direction].length > 0) ? retryPhotos[direction] : photos[direction] || [];
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
          console.error(`Error scaling image in ${direction}:`, error);
        }
      }
      if (scaleFactor) break;
    }

    if (scaleFactor) {
      const pixelArea = roofImage.contour.area;
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
    }

    try {
      const base64Image = roofImage.image.split(",")[1];
      const img = cv.imdecode(Buffer.from(base64Image, "base64"));
      const gray = img.cvtColor(cv.COLOR_BGR2GRAY);
      const edges = gray.canny(50, 150);
      const lines = edges.houghLinesP(0.1, Math.PI / 180, 50, 50, 10);

      let steepestAngle = 0;
      for (const line of lines) {
        const angle = Math.atan2(line.y2 - line.y1, line.x2 - line.x1) * 180 / Math.PI;
        if (Math.abs(angle) > steepestAngle) steepestAngle = Math.abs(angle);
      }

      if (steepestAngle > 45) pitch = "8/12";
      else if (steepestAngle > 30) pitch = "6/12";
      else pitch = "4/12";
    } catch (error) {
      console.error("Error estimating roof pitch:", error);
    }
  }

  const pitchFactor = { "4/12": 1.054, "6/12": 1.118, "8/12": 1.202 }[pitch] || 1.118;
  roofArea = area * pitchFactor;
  const baseHeight = 10;
  const roofHeight = (width / 2) * (parseInt(pitch.split("/")[0]) / 12);
  height = baseHeight + roofHeight;

  return {
    measurements: { width, length, area },
    roofInfo: { pitch, height: Math.round(height), roofArea: Math.round(roofArea), roofMaterial, isPitchReliable: !!roofImage, pitchSource: roofImage ? "user_image" : "default" },
    isReliable,
  };
}

async function analyzePhotosWithGoogleVision(photos, retryPhotos, bucket) {
  const directions = ["north", "south", "east", "west"];
  const allImages = directions.flatMap(direction => photos[direction] || []);
  const allRetryImages = directions.flatMap(direction => (retryPhotos && retryPhotos[direction]) || []);

  if (allImages.length < 4 && allRetryImages.length < 4) {
    return {
      windows: 0,
      doors: 0,
      windowSizes: [],
      doorSizes: [],
      images: {},
      allUploadedImages: {},
      isReliable: false,
      retryDirections: directions,
    };
  }

  const GOOGLE_VISION_API_KEY = process.env.GOOGLE_VISION_API_KEY;
  if (!GOOGLE_VISION_API_KEY) {
    return {
      windows: 0,
      doors: 0,
      windowSizes: [],
      doorSizes: [],
      images: {},
      allUploadedImages: {},
      isReliable: false,
      retryDirections: directions,
    };
  }

  let windowCount = 0;
  let doorCount = 0;
  let windowSizes = [];
  let doorSizes = [];
  let processedImages = {};
  const allUploadedImages = {};
  let isReliable = false;
  const retryDirections = [];

  for (const direction of directions) {
    const images = (retryPhotos && retryPhotos[direction] && retryPhotos[direction].length > 0) ? retryPhotos[direction] : photos[direction] || [];
    if (images.length === 0) {
      retryDirections.push(direction);
      continue;
    }

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
        console.error(`Error saving image for ${direction}:`, error);
        continue;
      }
    }

    if (allUploadedImages[direction].length > 0) {
      processedImages[direction] = allUploadedImages[direction][0];
    }

    let detectedInDirection = false;
    for (const [index, image] of images.entries()) {
      try {
        const base64Image = image.split(",")[1];
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
          retryDirections.push(direction);
          continue;
        }

        const visionData = await visionResponse.json();
        const objects = visionData.responses[0]?.localizedObjectAnnotations || [];
        const windowsInImage = objects.filter(obj => obj.name.toLowerCase().includes("window") && obj.score > 0.4).length;
        const doorsInImage = objects.filter(obj => obj.name.toLowerCase().includes("door") && obj.score > 0.4).length;

        if (windowsInImage > 0) {
          windowCount += windowsInImage;
          for (let i = 0; i < windowsInImage; i++) {
            windowSizes.push(Math.random() > 0.5 ? "4ft x 5ft" : "3ft x 4ft");
          }
        }

        if (doorsInImage > 0) {
          doorCount += doorsInImage;
          for (let i = 0; i < doorsInImage; i++) {
            doorSizes.push(Math.random() > 0.5 ? "3ft x 8ft" : "3ft x 7ft");
          }
        }

        if (windowsInImage === 0 && doorsInImage === 0) {
          retryDirections.push(direction);
        } else {
          detectedInDirection = true;
          isReliable = true;
        }
      } catch (error) {
        console.error(`Error analyzing image for ${direction}:`, error);
        retryDirections.push(direction);
      }
    }
  }

  return {
    windows: windowCount,
    doors: doorCount,
    windowSizes,
    doorSizes,
    images: processedImages,
    allUploadedImages,
    isReliable,
    retryDirections,
  };
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

  const estimates = [siding, paint, ...windowEstimates, ...doorEstimates, roofing];
  console.log("Material estimates:", estimates); // Debug log
  return estimates;
}

function calculateCostEstimates(materialEstimates, windowDoorCount, area, addressData) {
  let totalCostLow = 0;
  let totalCostHigh = 0;
  const costBreakdown = [];

  const costRanges = {
    siding: { materialLow: 6, materialHigh: 10, laborLow: 3, laborHigh: 5 },
    paint: { materialLow: 30, materialHigh: 50, laborLow: 1, laborHigh: 2.5 },
    window: { materialLow: 400, materialHigh: 700, laborLow: 150, laborHigh: 300 },
    door: { materialLow: 800, materialHigh: 1200, laborLow: 250, laborHigh: 450 },
    roofing: { materialLow: 2.5, materialHigh: 4.5, laborLow: 2, laborHigh: 3.5 },
  };

  const { multiplierLow, multiplierHigh } = getLocationMultiplier(addressData);

  materialEstimates.forEach(item => {
    if (item.includes("Siding")) {
      const sidingArea = parseInt(item.match(/\d+/)[0]);
      const materialCostLow = sidingArea * costRanges.siding.materialLow * multiplierLow;
      const materialCostHigh = sidingArea * costRanges.siding.materialHigh * multiplierHigh;
      const laborCostLow = sidingArea * costRanges.siding.laborLow * multiplierLow;
      const laborCostHigh = sidingArea * costRanges.siding.laborHigh * multiplierHigh;
      totalCostLow += materialCostLow + laborCostLow;
      totalCostHigh += materialCostHigh + laborCostHigh;
      costBreakdown.push(
        `Siding Material: $${Math.round(materialCostLow)}–$${Math.round(materialCostHigh)} (${sidingArea} sq ft at $${costRanges.siding.materialLow}–$${costRanges.siding.materialHigh}/sq ft)`,
        `Siding Labor: $${Math.round(laborCostLow)}–$${Math.round(laborCostHigh)} (${sidingArea} sq ft at $${costRanges.siding.laborLow}–$${costRanges.siding.laborHigh}/sq ft)`
      );
    } else if (item.includes("Exterior Paint")) {
      const gallons = parseInt(item.match(/\d+/)[0]);
      const materialCostLow = gallons * costRanges.paint.materialLow * multiplierLow;
      const materialCostHigh = gallons * costRanges.paint.materialHigh * multiplierHigh;
      const laborCostLow = area * costRanges.paint.laborLow * multiplierLow;
      const laborCostHigh = area * costRanges.paint.laborHigh * multiplierHigh;
      totalCostLow += materialCostLow + laborCostLow;
      totalCostHigh += materialCostHigh + laborCostHigh;
      costBreakdown.push(
        `Exterior Paint Material: $${Math.round(materialCostLow)}–$${Math.round(materialCostHigh)} (${gallons} gallons at $${costRanges.paint.materialLow}–$${costRanges.paint.materialHigh}/gallon)`,
        `Exterior Paint Labor: $${Math.round(laborCostLow)}–$${Math.round(laborCostHigh)} (${area} sq ft at $${costRanges.paint.laborLow}–$${costRanges.paint.laborHigh}/sq ft)`
      );
    } else if (item.includes("Window")) {
      const materialCostLow = costRanges.window.materialLow * multiplierLow;
      const materialCostHigh = costRanges.window.materialHigh * multiplierHigh;
      const laborCostLow = costRanges.window.laborLow * multiplierLow;
      const laborCostHigh = costRanges.window.laborHigh * multiplierHigh;
      totalCostLow += materialCostLow + laborCostLow;
      totalCostHigh += materialCostHigh + laborCostHigh;
      costBreakdown.push(
        `${item} Material: $${Math.round(materialCostLow)}–$${Math.round(materialCostHigh)}`,
        `${item} Labor: $${Math.round(laborCostLow)}–$${Math.round(laborCostHigh)}`
      );
    } else if (item.includes("Door")) {
      const materialCostLow = costRanges.door.materialLow * multiplierLow;
      const materialCostHigh = costRanges.door.materialHigh * multiplierHigh;
      const laborCostLow = costRanges.door.laborLow * multiplierLow;
      const laborCostHigh = costRanges.door.laborHigh * multiplierHigh;
      totalCostLow += materialCostLow + laborCostLow;
      totalCostHigh += materialCostHigh + laborCostHigh;
      costBreakdown.push(
        `${item} Material: $${Math.round(materialCostLow)}–$${Math.round(materialCostHigh)}`,
        `${item} Labor: $${Math.round(laborCostLow)}–$${Math.round(laborCostHigh)}`
      );
    } else if (item.includes("Roofing")) {
      const roofArea = parseInt(item.match(/\d+/)[0]);
      const materialCostLow = roofArea * costRanges.roofing.materialLow * multiplierLow;
      const materialCostHigh = roofArea * costRanges.roofing.materialHigh * multiplierHigh;
      const laborCostLow = roofArea * costRanges.roofing.laborLow * multiplierLow;
      const laborCostHigh = roofArea * costRanges.roofing.laborHigh * multiplierHigh;
      totalCostLow += materialCostLow + laborCostLow;
      totalCostHigh += materialCostHigh + laborCostHigh;
      costBreakdown.push(
        `Roofing Material: $${Math.round(materialCostLow)}–$${Math.round(materialCostHigh)} (${roofArea} sq ft at $${costRanges.roofing.materialLow}–$${costRanges.roofing.materialHigh}/sq ft)`,
        `Roofing Labor: $${Math.round(laborCostLow)}–$${Math.round(laborCostHigh)} (${roofArea} sq ft at $${costRanges.roofing.laborLow}–$${costRanges.roofing.laborHigh}/sq ft)`
      );
    }
  });

  const costResult = { totalCostLow: Math.round(totalCostLow), totalCostHigh: Math.round(totalCostHigh), costBreakdown };
  console.log("Cost estimates result:", costResult); // Debug log
  return costResult;
}

function calculateTimeline(area, windowDoorCount) {
  let weeks = Math.ceil(area / 500);
  const additionalDays = (windowDoorCount.windows + windowDoorCount.doors);
  weeks += Math.ceil(additionalDays / 5);
  console.log(`Timeline estimate: ${weeks} weeks`); // Debug log
  return weeks;
}