const admin = require("firebase-admin");
const fetch = require("node-fetch");
const cv = require("opencv4nodejs"); // Add OpenCV dependency

exports.handler = async (event) => {
  console.log("remodel invoked with event:", JSON.stringify(event));

  try {
    if (!admin.apps.length) {
      console.log("Initializing Firebase Admin...");
      try {
        admin.initializeApp({
          credential: admin.credential.cert({
            projectId: "turtle-treasure-giveaway",
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
          }),
        });
        console.log("Firebase Admin initialized successfully in remodel");
      } catch (initError) {
        console.error("Firebase Admin initialization failed:", initError.message);
        throw new Error("Failed to initialize Firebase: " + initError.message);
      }
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
      console.error("Failed to parse request body:", parseError.message);
      throw new Error("Invalid request body: Failed to parse JSON");
    }

    const { address, photos, retryPhotos, windowCount, doorCount, windowSizes, doorSizes, roofOutline } = body;

    if (!address) {
      throw new Error("Missing address in request body");
    }

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
    console.log(`Processing remodel for address: ${address}, total user images received: ${allImages.length}, total retry images received: ${allRetryImages.length}`);

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

    console.log("Address validated:", addressData[0].display_name);
    const lat = parseFloat(addressData[0].lat);
    const lon = parseFloat(addressData[0].lon);

    const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
    let streetViewData = { images: {}, status: "not_used", roofPitchStatus: "not_attempted" };
    if (allImages.length === 0 && allRetryImages.length === 0) {
      streetViewData = await getStreetViewImages(lat, lon, GOOGLE_MAPS_API_KEY);
    }

    // Get building data using Google Maps satellite imagery
    const buildingData = await getBuildingDataFromSatellite(lat, lon, GOOGLE_MAPS_API_KEY, roofOutline);
    const measurements = buildingData.measurements;

    const roofInfo = await getRoofInfo(lat, lon, buildingData.roofInfo, photos, streetViewData.images, GOOGLE_MAPS_API_KEY);
    streetViewData.roofPitchStatus = roofInfo.streetViewRoofPitchStatus || "not_attempted";
    const isMeasurementsReliable = buildingData.isReliable;

    let windowDoorInfo;
    if (windowCount !== null && doorCount !== null && windowSizes && doorSizes) {
      windowDoorInfo = {
        windows: windowCount,
        doors: doorCount,
        windowSizes: windowSizes,
        doorSizes: doorSizes,
        images: {},
        isReliable: true,
      };
      console.log(`Using manual window/door counts and sizes: ${windowDoorInfo.windows} windows, ${windowDoorInfo.doors} doors`);
    } else {
      windowDoorInfo = await analyzePhotosWithOpenCV(photos, retryPhotos, streetViewData.images, bucket);
      windowDoorInfo.streetViewStatus = streetViewData.status;

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

    for (const direction of directions) {
      if (processedImages[direction] === undefined) {
        delete processedImages[direction];
      }
    }

    const materialEstimates = calculateMaterialEstimates(measurements, windowDoorCount, roofInfo);
    const costEstimates = calculateCostEstimates(materialEstimates, windowDoorCount, measurements.area);
    const timelineEstimate = calculateTimeline(measurements.area, windowDoorCount);

    let satelliteImage = null;
    let satelliteImageError = null;
    if (GOOGLE_MAPS_API_KEY) {
      satelliteImage = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lon}&zoom=20&size=600x600&maptype=satellite&key=${GOOGLE_MAPS_API_KEY}`;
      try {
        const imageResponse = await fetch(satelliteImage);
        if (!imageResponse.ok) {
          satelliteImageError = `Google Maps API error: ${await imageResponse.text()}`;
          satelliteImage = null;
        }
      } catch (error) {
        satelliteImageError = `Network error: ${error.message}`;
        satelliteImage = null;
      }
    } else {
      satelliteImageError = "Google Maps API key is missing.";
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
      allUploadedImages,
      satelliteImage,
      satelliteImageError,
      lat,
      lon,
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
        allUploadedImages,
        satelliteImage,
        satelliteImageError,
        usedStreetView: (allImages.length + allRetryImages.length) === 0 && Object.keys(processedImages).length > 0,
        streetViewStatus: windowDoorInfo.streetViewStatus,
        streetViewRoofPitchStatus: streetViewData.roofPitchStatus,
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
  if (!apiKey) {
    return { images: {}, status: "api_key_missing", roofPitchStatus: "api_key_missing" };
  }

  const directions = ["north", "south", "east", "west"];
  const headings = [0, 180, 90, 270];
  const streetViewImages = {};

  const metadataUrl = `https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lon}&key=${apiKey}`;
  let metadataResponse;
  try {
    metadataResponse = await fetch(metadataUrl);
    if (!metadataResponse.ok) {
      return { images: {}, status: "metadata_failed", roofPitchStatus: "metadata_failed" };
    }
    const metadata = await metadataResponse.json();
    if (metadata.status !== "OK") {
      return { images: {}, status: "unavailable", roofPitchStatus: "unavailable" };
    }
  } catch (error) {
    return { images: {}, status: "metadata_error", roofPitchStatus: "metadata_error" };
  }

  for (let i = 0; i < directions.length; i++) {
    const direction = directions[i];
    const heading = headings[i];
    const url = `https://maps.googleapis.com/maps/api/streetview?size=600x400&location=${lat},${lon}&heading=${heading}&pitch=0&fov=90&key=${apiKey}`;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          continue;
        }
        const imageBuffer = await response.buffer();
        const fileName = `remodels/streetview_${Date.now()}_${direction}.jpg`;
        const file = bucket.file(fileName);
        await file.save(imageBuffer, {
          metadata: { contentType: "image/jpeg" },
        });
        const [signedUrl] = await file.getSignedUrl({
          action: "read",
          expires: "03-09-2500",
        });
        streetViewImages[direction] = signedUrl;
        break;
      } catch (error) {}
    }
  }

  return {
    images: streetViewImages,
    status: Object.keys(streetViewImages).length > 0 ? "success" : "no_images",
    roofPitchStatus: Object.keys(streetViewImages).length > 0 ? "success" : "no_images",
  };
}

async function getBuildingDataFromSatellite(lat, lon, apiKey, roofOutline) {
  if (!apiKey) {
    return {
      measurements: { width: 40, length: 32, area: 1280 },
      roofInfo: { pitch: "6/12", height: 16, roofArea: 1431, roofMaterial: "Asphalt Shingles" },
      isReliable: false,
    };
  }

  const satelliteUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lon}&zoom=20&size=600x600&maptype=satellite&key=${apiKey}`;
  let imageBuffer;
  try {
    const response = await fetch(satelliteUrl);
    if (!response.ok) {
      return {
        measurements: { width: 40, length: 32, area: 1280 },
        roofInfo: { pitch: "6/12", height: 16, roofArea: 1431, roofMaterial: "Asphalt Shingles" },
        isReliable: false,
      };
    }
    imageBuffer = await response.buffer();
  } catch (error) {
    return {
      measurements: { width: 40, length: 32, area: 1280 },
      roofInfo: { pitch: "6/12", height: 16, roofArea: 1431, roofMaterial: "Asphalt Shingles" },
      isReliable: false,
    };
  }

  let width = 40, length = 32, area = 1280, isReliable = false;
  if (roofOutline) {
    // Assume roofOutline is an array of points [(x1, y1), (x2, y2), ...] in pixels
    const pixelArea = calculatePolygonArea(roofOutline);
    const feetPerPixel = 0.1; // At zoom 20
    area = Math.round(pixelArea * feetPerPixel * feetPerPixel);
    width = Math.round(Math.sqrt(area) * 1.25); // Approximate width (assuming rectangular)
    length = Math.round(area / width);
    isReliable = true;
  } else {
    // Use OpenCV to detect roof outline
    const img = cv.imdecode(Buffer.from(imageBuffer));
    const gray = img.cvtColor(cv.COLOR_BGR2GRAY);
    const edges = gray.canny(50, 150);
    const contours = edges.findContours(cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    let maxArea = 0;
    let roofContour = null;

    for (const contour of contours) {
      const area = contour.area;
      if (area > maxArea && area > 1000) { // Minimum area threshold
        maxArea = area;
        roofContour = contour;
      }
    }

    if (roofContour) {
      const rect = roofContour.minAreaRect();
      const pixelWidth = rect.size.width;
      const pixelLength = rect.size.height;
      const feetPerPixel = 0.1;
      width = Math.round(pixelWidth * feetPerPixel);
      length = Math.round(pixelLength * feetPerPixel);
      area = width * length;
      isReliable = true;

      if (area < 500 || area > 5000) {
        width = 40;
        length = 32;
        area = 1280;
        isReliable = false;
      }
    }
  }

  const pitch = "6/12";
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

function calculatePolygonArea(points) {
  let area = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += points[i].x * points[j].y;
    area -= points[j].x * points[i].y;
  }
  return Math.abs(area) / 2;
}

async function getRoofInfo(lat, lon, baseRoofInfo, userPhotos, streetViewImages, apiKey) {
  let { pitch, height, roofArea, roofMaterial } = baseRoofInfo;
  let isPitchReliable = false;
  let pitchSource = "default";
  let streetViewRoofPitchStatus = "not_attempted";

  const directions = ["north", "south", "east", "west"];
  const allUserImages = directions
    .flatMap(direction => userPhotos[direction] || [])
    .filter(image => image && typeof image === "string" && image.startsWith("data:image/"));

  if (allUserImages.length > 0) {
    for (const [index, image] of allUserImages.entries()) {
      try {
        const base64Image = image.split(",")[1];
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
        isPitchReliable = true;
        pitchSource = "user_image";
        break;
      } catch (error) {
        pitchSource = "user_image_failed";
      }
    }
  }

  if (!isPitchReliable && Object.keys(streetViewImages).length > 0) {
    for (const direction of directions) {
      const url = streetViewImages[direction];
      if (!url) continue;

      try {
        const response = await fetch(url);
        const imageBuffer = await response.buffer();
        const img = cv.imdecode(imageBuffer);
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
        isPitchReliable = true;
        pitchSource = "street_view";
        streetViewRoofPitchStatus = "success";
        break;
      } catch (error) {
        streetViewRoofPitchStatus = "failed";
      }
    }
  }

  const pitchValues = {
    "4/12": 1.054,
    "6/12": 1.118,
    "8/12": 1.202,
  };
  const pitchFactor = pitchValues[pitch] || 1.118;
  roofArea = baseRoofInfo.roofArea * (pitchFactor / 1.118);

  return { pitch, height, roofArea: Math.round(roofArea), roofMaterial, isPitchReliable, pitchSource, streetViewRoofPitchStatus };
}

async function analyzePhotosWithOpenCV(photos, retryPhotos, streetViewImages, bucket) {
  const directions = ["north", "south", "east", "west"];
  const allImages = directions.flatMap(direction => photos[direction] || []);
  const allRetryImages = directions.flatMap(direction => (retryPhotos && retryPhotos[direction]) || []);

  let windowCount = 0;
  let doorCount = 0;
  let windowSizes = [];
  let doorSizes = [];
  let processedImages = { ...streetViewImages };
  const allUploadedImages = {};
  let isReliable = false;
  const retryDirections = [];

  // Load Haar Cascade classifiers (assumes you have these files)
  const windowCascade = new cv.CascadeClassifier("haarcascade_window.xml");
  const doorCascade = new cv.CascadeClassifier("haarcascade_door.xml");

  for (const direction of directions) {
    const images = (retryPhotos && retryPhotos[direction] && retryPhotos[direction].length > 0) ? retryPhotos[direction] : photos[direction] || [];
    if (images.length === 0) {
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
        continue;
      }
    }

    if (allUploadedImages[direction].length > 0) {
      processedImages[direction] = allUploadedImages[direction][0];
    }

    const photosToProcess = images;
    let detectedInDirection = false;

    for (const [index, image] of photosToProcess.entries()) {
      try {
        const base64Image = image.split(",")[1];
        const img = cv.imdecode(Buffer.from(base64Image, "base64"));
        const gray = img.cvtColor(cv.COLOR_BGR2GRAY);

        const windows = windowCascade.detectMultiScale(gray, 1.1, 3).objects;
        const doors = doorCascade.detectMultiScale(gray, 1.1, 3).objects;

        windowCount += windows.length;
        doorCount += doors.length;

        for (let i = 0; i < windows.length; i++) {
          const size = Math.random() > 0.5 ? "4ft x 5ft" : "3ft x 4ft";
          windowSizes.push(size);
        }

        for (let i = 0; i < doors.length; i++) {
          const size = Math.random() > 0.5 ? "3ft x 8ft" : "3ft x 7ft";
          doorSizes.push(size);
        }

        if (windows.length === 0 && doors.length === 0) {
          retryDirections.push(direction);
        } else {
          detectedInDirection = true;
          isReliable = true;
        }
      } catch (error) {
        retryDirections.push(direction);
      }
    }
  }

  if (allImages.length === 0 && allRetryImages.length === 0) {
    for (const direction of directions) {
      const url = streetViewImages[direction];
      if (!url) continue;

      try {
        const response = await fetch(url);
        const imageBuffer = await response.buffer();
        const img = cv.imdecode(imageBuffer);
        const gray = img.cvtColor(cv.COLOR_BGR2GRAY);

        const windows = windowCascade.detectMultiScale(gray, 1.1, 3).objects;
        const doors = doorCascade.detectMultiScale(gray, 1.1, 3).objects;

        windowCount += windows.length;
        doorCount += doors.length;

        for (let i = 0; i < windows.length; i++) {
          const size = Math.random() > 0.5 ? "4ft x 5ft" : "3ft x 4ft";
          windowSizes.push(size);
        }

        for (let i = 0; i < doors.length; i++) {
          const size = Math.random() > 0.5 ? "3ft x 8ft" : "3ft x 7ft";
          doorSizes.push(size);
        }

        if (windows.length > 0 || doors.length > 0) {
          isReliable = true;
        }
      } catch (error) {}
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

  return [siding, paint, ...windowEstimates, ...doorEstimates, roofing];
}

function calculateCostEstimates(materialEstimates, windowDoorCount, area) {
  let totalCost = 0;
  const costBreakdown = [];

  materialEstimates.forEach(item => {
    if (item.includes("Siding")) {
      const sidingArea = parseInt(item.match(/\d+/)[0]);
      const cost = sidingArea * 8;
      totalCost += cost;
      costBreakdown.push(`Siding: $${cost} (${sidingArea} sq ft at $8/sq ft)`);
    } else if (item.includes("Exterior Paint")) {
      const gallons = parseInt(item.match(/\d+/)[0]);
      const paintCost = gallons * 40;
      const paintLaborCost = area * 1.5;
      totalCost += paintCost + paintLaborCost;
      costBreakdown.push(`Exterior Paint: $${paintCost} (${gallons} gallons at $40/gallon), Paint Labor: $${paintLaborCost} (${area} sq ft at $1.50/sq ft)`);
    } else if (item.includes("Window")) {
      const cost = 500;
      totalCost += cost;
      costBreakdown.push(`${item}: $${cost}`);
    } else if (item.includes("Door")) {
      const cost = 1000;
      totalCost += cost;
      costBreakdown.push(`${item}: $${cost}`);
    } else if (item.includes("Roofing")) {
      const roofArea = parseInt(item.match(/\d+/)[0]);
      const cost = roofArea * 3;
      totalCost += cost;
      costBreakdown.push(`Roofing: $${cost} (${roofArea} sq ft at $3/sq ft)`);
    }
  });

  const laborCost = area * 25;
  totalCost += laborCost;
  costBreakdown.push(`Labor: $${laborCost} (estimated at $25/sq ft for ${area} sq ft)`);

  return { totalCost: Math.round(totalCost), costBreakdown };
}

function calculateTimeline(area, windowDoorCount) {
  let weeks = Math.ceil(area / 500);
  const additionalDays = (windowDoorCount.windows + windowDoorCount.doors);
  weeks += Math.ceil(additionalDays / 5);
  return weeks;
}