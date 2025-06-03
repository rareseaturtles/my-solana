// Constants
const DIRECTIONS = ["north", "south", "east", "west"];
const IMAGE_SIZE_LIMIT = 500 * 1024; // 500KB
const IMAGE_PROCESSING_TIMEOUT = 30000; // 30 seconds for better UX

// Utility Functions
function $(id) {
  const element = document.getElementById(id);
  if (!element) {
    console.error(`Frontend - Element with ID "${id}" not found in DOM`);
  }
  return element;
}

function createElement(type, styles, attributes = {}) {
  const element = document.createElement(type);
  Object.assign(element.style, styles);
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
  return element;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith("image/")) {
      return reject(new Error("Invalid file type. Please upload images (JPEG, PNG)."));
    }
    const reader = new FileReader();
    reader.onload = () => {
      console.log(`Frontend - Converted file ${file.name} to base64, length: ${reader.result.length}`);
      if (!reader.result || typeof reader.result !== "string") {
        return reject(new Error(`Failed to convert ${file.name} to base64.`));
      }
      resolve(reader.result);
    };
    reader.onerror = () => {
      console.error(`Frontend - Error reading file ${file.name}`);
      reject(new Error(`Failed to read file ${file.name}.`));
    };
    reader.readAsDataURL(file);
  });
}

function dataURLtoFile(dataUrl, filename) {
  const arr = dataUrl.split(",");
  const mime = arr[0].match(/:(.*?);/)[1];
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) u8arr[n] = bstr.charCodeAt(n);
  return new File([u8arr], filename, { type: mime });
}

function displayError(message) {
  const results = $("results");
  if (results) {
    results.innerHTML = `
      <div style="background: white; border-radius: 8px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1); padding: 2rem; text-align: center;" role="alert">
        <p style="color: #d32f2f; margin: 0.5rem 0;">${message}</p>
        <p style="margin: 0.5rem 0;">Please try again or contact Indy Home Improvements at <a href="tel:7653663344" style="color: #e67e22; text-decoration: none;">765-366-3344</a> for assistance.</p>
      </div>
    `;
  }
}

function displayWarning(message) {
  console.log("Frontend - Warning:", message);
  const resultsDiv = $("results");
  if (resultsDiv && resultsDiv.innerHTML === "") {
    resultsDiv.innerHTML = `
      <div style="background: white; border-radius: 8px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1); padding: 2rem; text-align: center;" role="alert">
        <p style="color: #e67e22; margin: 0.5rem 0;">${message}</p>
      </div>
    `;
  }
}

function showProgress(message) {
  const results = $("results");
  if (results) {
    results.innerHTML = `
      <div style="text-align: center;">
        <p>${message} <span class="spinner" style="display: inline-block; width: 16px; height: 16px; border: 2px solid #e67e22; border-top-color: transparent; border-radius: 50%; animation: spin 1s linear infinite;"></span></p>
      </div>
      <style>@keyframes spin { to { transform: rotate(360deg); } }</style>
    `;
  }
}

async function convertPhotosToBase64(photoFiles, direction) {
  const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Image processing timed out. Please try uploading smaller images.")), IMAGE_PROCESSING_TIMEOUT));
  const results = [];
  for (const file of photoFiles) {
    if (file.size > IMAGE_SIZE_LIMIT) {
      throw new Error(`Image ${file.name} exceeds 500KB. Please upload a smaller image.`);
    }
    const base64 = await Promise.race([fileToBase64(file), timeoutPromise]);
    results.push(base64);
  }
  return results;
}

// Load Google Maps API dynamically
let map, marker, userPinLatLng = null;
let isGoogleMapsLoaded = false;

async function loadGoogleMapsApi() {
  try {
    console.log("Frontend - Fetching Google Maps API key from remodel.js...");
    const response = await fetch("/.netlify/functions/remodel?action=get-api-key", {
      method: "GET",
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch API key: ${response.status} - ${await response.text()}`);
    }
    const data = await response.json();
    if (data.error) {
      throw new Error(data.error);
    }
    const apiKey = data.apiKey;

    console.log("Frontend - Successfully retrieved Google Maps API key");
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places&callback=initGoogleMaps`;
      script.async = true;
      script.defer = true;
      script.onerror = () => {
        console.error("Frontend - Failed to load Google Maps API script");
        reject(new Error("Failed to load Google Maps API script"));
      };
      window.initGoogleMaps = () => {
        console.log("Frontend - Google Maps API script loaded successfully");
        isGoogleMapsLoaded = true;
        resolve();
      };
      document.head.appendChild(script);
    });
  } catch (error) {
    console.error("Frontend - Error loading Google Maps API:", error);
    isGoogleMapsLoaded = false;
    throw error;
  }
}

async function initializeMap(initialLat, initialLng) {
  const mapContainer = $("mapContainer");
  if (!mapContainer) {
    console.error("Frontend - Map container not found in DOM");
    displayWarning("Map container not found. Estimates will use address-based coordinates.");
    return;
  }

  if (!isGoogleMapsLoaded) {
    console.error("Frontend - Google Maps API not loaded. Cannot initialize map.");
    displayWarning("Unable to load Google Maps. Please proceed with the estimate using address-based coordinates, or try again later.");
    mapContainer.style.display = "none";
    return;
  }

  try {
    console.log("Frontend - Attempting to initialize Google Map with center:", { lat: initialLat, lng: initialLng });
    mapContainer.style.display = "block"; // Ensure the container is visible before initializing
    map = new google.maps.Map(mapContainer, {
      center: { lat: initialLat, lng: initialLng },
      zoom: 15,
      mapTypeId: "satellite",
    });

    marker = new google.maps.Marker({
      position: { lat: initialLat, lng: initialLng },
      map: map,
      draggable: true,
      title: "Drag to mark your house",
    });

    // Add event listeners with error handling
    google.maps.event.addListener(marker, "dragend", () => {
      try {
        const position = marker.getPosition();
        userPinLatLng = { lat: position.lat(), lng: position.lng() };
        console.log(`Frontend - User dropped pin at:`, userPinLatLng);
      } catch (error) {
        console.error("Frontend - Error in marker dragend event:", error);
      }
    });

    map.addListener("click", (event) => {
      try {
        marker.setPosition(event.latLng);
        userPinLatLng = { lat: event.latLng.lat(), lng: event.latLng.lng() };
        console.log(`Frontend - User clicked map to drop pin at:`, userPinLatLng);
      } catch (error) {
        console.error("Frontend - Error in map click event:", error);
      }
    });

    // Add a listener to detect if the map becomes idle (fully rendered)
    google.maps.event.addListenerOnce(map, "idle", () => {
      console.log("Frontend - Map fully rendered and idle");
    });

    // Add a resize trigger to ensure the map renders correctly if the container changes
    google.maps.event.trigger(map, "resize");
    console.log("Frontend - Map initialized successfully with center:", { lat: initialLat, lng: initialLng });

    const results = $("results");
    if (results) {
      results.innerHTML = `
        <p style="text-align: center; margin: 0.5rem 0;">Please drag the pin to the exact location of your house for a more accurate estimate, or proceed with the address-based location.</p>
      `;
    }
  } catch (error) {
    console.error("Frontend - Error initializing Google Map:", error);
    displayWarning("Unable to load Google Maps. Please proceed with the estimate using address-based coordinates, or try again later.");
    mapContainer.style.display = "none";
  }
}

// Address Input Handler to Initialize Map
const addressInput = $("address");
if (addressInput) {
  addressInput.addEventListener("blur", async () => {
    const address = addressInput.value.trim();
    if (!address) return;

    try {
      showProgress("Locating address...");
      const addressResponse = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}`,
        { headers: { "User-Agent": "IndyHomeImprovements/1.0" } }
      );
      if (!addressResponse.ok) {
        throw new Error("Failed to validate address");
      }
      const addressData = await addressResponse.json();
      if (!addressData.length) {
        throw new Error("Invalid address: No results found");
      }

      const lat = parseFloat(addressData[0].lat);
      const lon = parseFloat(addressData[0].lon);

      // Load Google Maps API if not already loaded
      if (!isGoogleMapsLoaded) {
        await loadGoogleMapsApi();
      }

      await initializeMap(lat, lon);
    } catch (error) {
      console.error("Frontend - Address validation error:", error);
      displayWarning("Unable to locate address for map. Estimates will use address-based coordinates.");
      const mapContainer = $("mapContainer");
      if (mapContainer) mapContainer.style.display = "none";
    }
  });
}

// Form Submission Handler
const remodelForm = $("remodelForm");
if (remodelForm) {
  remodelForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const submitButton = e.target.querySelector("button[type='submit']");
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.innerHTML = "Processing...";
    }

    try {
      const address = $("address")?.value.trim();
      const components = Array.from($("components")?.selectedOptions || []).map(option => option.value);
      const photos = {
        north: Array.from($("northPhotos")?.files || []),
        south: Array.from($("southPhotos")?.files || []),
        east: Array.from($("eastPhotos")?.files || []),
        west: Array.from($("westPhotos")?.files || []),
      };
      const windowCount = parseInt($("windowCount")?.value) || 0;
      const doorCount = parseInt($("doorCount")?.value) || 0;

      // Validate Inputs
      if (!address) {
        throw new Error("Please enter a valid address.");
      }

      if (components.length === 0) {
        throw new Error("Please select at least one component to estimate (Roof, Windows, Doors, Siding).");
      }

      if (components.includes("windows") && (isNaN(windowCount) || windowCount < 0)) {
        throw new Error("Please provide a valid window count (0 or more) when estimating windows.");
      }

      if (components.includes("doors") && (isNaN(doorCount) || doorCount < 0)) {
        throw new Error("Please provide a valid door count (0 or more) when estimating doors.");
      }

      const totalImages = Object.values(photos).reduce((sum, arr) => sum + arr.length, 0);
      console.log(`Frontend - Total images selected: ${totalImages}`);

      // Warn About Multiple Images
      DIRECTIONS.forEach(direction => {
        if (photos[direction].length > 1) {
          displayWarning(`Multiple images uploaded for ${direction}. Only the first image will be processed for analysis, but all images will be saved.`);
        }
      });

      // Convert Photos to Base64 with Progress Indicator
      showProgress("Processing images...");
      const resolvedPhotos = {};
      for (const direction of DIRECTIONS) {
        resolvedPhotos[direction] = await convertPhotosToBase64(photos[direction], direction);
      }
      console.log("Frontend - Converted photos to base64:", Object.fromEntries(DIRECTIONS.map(dir => [dir, resolvedPhotos[dir].length])));

      // Include userPinLatLng in the request if available
      const requestData = {
        address,
        components,
        photos: resolvedPhotos,
        windowCount,
        doorCount,
        userPin: userPinLatLng || null,
      };

      // Send Request to Netlify Function
      showProgress("Generating estimate...");
      console.log("Frontend - Sending request to /.netlify/functions/remodel with data:", requestData);
      const response = await fetch("/.netlify/functions/remodel", {
        method: "POST",
        body: JSON.stringify(requestData),
      });
      console.log("Frontend - Response status:", response.status);

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Server error: ${response.status} - ${text}`);
      }

      const result = await response.json();
      console.log("Frontend - Server Response:", result);
      if (result.error) throw new Error(result.error);

      // Process and Display Results
      const remodelId = result.remodelId || "unknown";
      const addressDisplay = result.addressData?.display_name || "Unknown Address";
      const measurements = result.measurements || { width: "N/A", length: "N/A", area: "N/A" };
      const isMeasurementsReliable = result.isMeasurementsReliable || false;
      const windowDoorCount = result.windowDoorCount || { windows: 0, doors: 0, isReliable: true };
      const materialEstimates = result.materialEstimates || ["No estimates available"];
      const costEstimates = result.costEstimates || { totalCostLow: 0, totalCostHigh: 0, costBreakdown: ["No cost breakdown available"] };
      const timelineEstimate = result.timelineEstimate || "N/A";
      const roofInfo = result.roofInfo || { pitch: "N/A", height: "N/A", roofArea: "N/A", roofMaterial: "N/A", isPitchReliable: false, pitchSource: "default" };
      const processedImages = result.processedImages || {};
      const allUploadedImages = result.allUploadedImages || {};
      const satelliteViewImage = result.satelliteViewImage || null;
      const lat = result.addressData?.lat || 0;
      const lon = result.addressData?.lon || 0;

      const hasValidCost = costEstimates && typeof costEstimates.totalCostLow === "number" && typeof costEstimates.totalCostHigh === "number" && costEstimates.totalCostLow > 0 && costEstimates.totalCostHigh > 0;
      console.log("Frontend - Cost rendering check:", { isMeasurementsReliable, hasValidCost, costEstimates });

      let resultsHtml = `
        <div style="background: white; border-radius: 8px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1); padding: 2rem;" role="region" aria-label="Remodel Estimate Results">
          <h2 style="color: #1a3c34; margin-bottom: 1rem; font-size: 1.8rem; text-align: center;">Remodel Estimate</h2>
          <h3 style="color: #1a3c34; margin-bottom: 0.5rem; font-size: 1.3rem;">Project Overview</h3>
          <p style="margin: 0.5rem 0;"><strong>Address:</strong> ${addressDisplay}</p>
          <p style="margin: 0.5rem 0;"><strong>Dimensions:</strong> ${measurements.width}ft x ${measurements.length}ft (Area: ${measurements.area} sq ft)</p>
          <p style="margin: 0.5rem 0;"><strong>Height (Est.):</strong> ${roofInfo.height}ft | <strong>Roof Pitch:</strong> ${roofInfo.pitch}</p>
      `;

      if (components.includes("windows") || components.includes("doors")) {
        resultsHtml += `
          <p style="margin: 0.5rem 0;"><strong>Windows:</strong> ${components.includes("windows") ? windowDoorCount.windows : "N/A"} | <strong>Doors:</strong> ${components.includes("doors") ? windowDoorCount.doors : "N/A"}</p>
          <p style="font-style: italic; color: #666; font-size: 0.9rem; margin: 0.5rem 0;">Window and door dimensions will be measured on-site for accuracy.</p>
        `;
      }

      if (!isMeasurementsReliable) {
        resultsHtml += `<p style="color: #d32f2f; font-size: 0.9rem; margin: 0.5rem 0;">Building dimensions are estimates based on ${totalImages === 0 ? "satellite imagery analysis or regional averages" : "your uploaded photos"}. For accurate results, please upload clear photos or verify the dimensions.</p>`;
      }

      if (!roofInfo.isPitchReliable && components.includes("roof")) {
        let pitchMessage = "Roof pitch is a default estimate.";
        if (totalImages > 0) pitchMessage = "Roof pitch is a default estimate because the uploaded images could not be processed for analysis.";
        pitchMessage += " Please upload a clear photo showing the roof for a more accurate assessment.";
        resultsHtml += `<p style="color: #d32f2f; font-size: 0.9rem; margin: 0.5rem 0;">${pitchMessage}</p>`;
      } else if (components.includes("roof")) {
        resultsHtml += `<p style="font-style: italic; color: #666; font-size: 0.9rem; margin: 0.5rem 0;">Roof pitch estimated from ${roofInfo.pitchSource === "user_image" ? "your uploaded photo" : "default"}.</p>`;
      }

      resultsHtml += `
        <h3 style="color: #1a3c34; margin-bottom: 0.5rem; margin-top: 1.5rem; font-size: 1.3rem;">Material Breakdown</h3>
        <ul style="list-style-type: disc; padding-left: 1.5rem; margin-bottom: 1rem;">${materialEstimates.map(item => `<li>${item}</li>`).join("")}</ul>
        <h3 style="color: #1a3c34; margin-bottom: 0.5rem; margin-top: 1.5rem; font-size: 1.3rem;">Cost Estimate (Approximate)</h3>
      `;

      if (hasValidCost) {
        resultsHtml += `
          <p style="margin: 0.5rem 0;"><strong>Total:</strong> $${costEstimates.totalCostLow.toLocaleString()}–$${costEstimates.totalCostHigh.toLocaleString()}</p>
          <ul style="list-style-type: disc; padding-left: 1.5rem; margin-bottom: 1rem;">${costEstimates.costBreakdown.map(item => `<li>${item}</li>`).join("")}</ul>
          <p style="font-style: italic; color: #666; font-size: 0.9rem; margin: 0.5rem 0;">Costs are approximate and may vary based on final measurements, material prices, labor rates, and location-specific factors.</p>
        `;
        if (!isMeasurementsReliable) {
          resultsHtml += `<p style="color: #d32f2f; font-size: 0.9rem; margin: 0.5rem 0;">This estimate is based on ${totalImages === 0 ? "satellite imagery analysis or regional averages" : "your uploaded photos"}. For a more accurate estimate, upload clear photos.</p>`;
        }
      } else {
        resultsHtml += `<p style="color: #d32f2f; margin: 0.5rem 0;">Unable to generate cost estimate due to missing data.</p>`;
        console.log("Frontend - Cost estimate display fallback triggered. hasValidCost:", hasValidCost);
      }

      resultsHtml += `
        <h3 style="color: #1a3c34; margin-bottom: 0.5rem; margin-top: 1.5rem; font-size: 1.3rem;">Estimated Timeline</h3>
        <p style="margin: 0.5rem 0;">${timelineEstimate} weeks</p>
        <p style="font-style: italic; color: #666; font-size: 0.9rem; margin: 0.5rem 0;">Timeline depends on project scope, weather, and crew availability.</p>
        <h3 style="color: #1a3c34; margin-bottom: 0.5rem; margin-top: 1.5rem; font-size: 1.3rem;">Permit Information</h3>
        <p style="margin: 0.5rem 0;">Remodeling in your area may require permits for structural, electrical, or plumbing work. Contact your local building department.</p>
        <p style="margin: 0.5rem 0;"><a href="https://www.usa.gov/local-building-permits" target="_blank" style="color: #e67e22; text-decoration: none;">Learn More About Permits</a></p>
      `;

      let hasUserImages = false;
      DIRECTIONS.forEach(direction => {
        if (processedImages[direction]) {
          hasUserImages = true;
          resultsHtml += `
            <h3 style="color: #1a3c34; margin-bottom: 0.5rem; margin-top: 1.5rem; font-size: 1.3rem;">${direction.charAt(0).toUpperCase() + direction.slice(1)}-Facing Image (Processed)</h3>
            <div style="text-align: center;">
              <img src="${processedImages[direction]}" alt="${direction} House Image" style="max-width: 100%; border-radius: 8px; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1); margin: 1rem 0;">
            </div>
          `;
        }
        if (allUploadedImages[direction] && allUploadedImages[direction].length > 0) {
          hasUserImages = true;
          resultsHtml += `
            <h3 style="color: #1a3c34; margin-bottom: 0.5rem; margin-top: 1.5rem; font-size: 1.3rem;">${direction.charAt(0).toUpperCase() + direction.slice(1)}-Facing Images (All Uploaded)</h3>
            <div style="text-align: center;">
              ${allUploadedImages[direction].map(url => `
                <img src="${url}" alt="${direction} House Image" style="max-width: 100%; border-radius: 8px; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1); margin: 1rem 0;">
              `).join("")}
            </div>
          `;
        }
      });

      if (!hasUserImages && satelliteViewImage) {
        resultsHtml += `
          <h3 style="color: #1a3c34; margin-bottom: 0.5rem; margin-top: 1.5rem; font-size: 1.3rem;">Satellite View Image (Google Maps)</h3>
          <div style="text-align: center;">
            <img src="${satelliteViewImage}" alt="Satellite View Image" style="max-width: 100%; border-radius: 8px; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1); margin: 1rem 0;">
            <p style="font-style: italic; color: #666; font-size: 0.9rem; margin: 0.5rem 0;">Image sourced from Google Maps Satellite View. Measurements ${isMeasurementsReliable ? "are based on this image" : "could not be determined accurately from this image; regional averages used instead"}.</p>
          </div>
        `;
      }

      if (totalImages > 0) {
        resultsHtml += `<p style="font-style: italic; color: #666; font-size: 0.9rem; margin: 0.5rem 0;">Processed ${Object.values(processedImages).length} user-uploaded image(s) for dimension estimation. Up to 1 image per direction is processed.</p>`;
      }

      if (lat && lon) {
        resultsHtml += `
          <h3 style="color: #1a3c34; margin-bottom: 0.5rem; margin-top: 1.5rem; font-size: 1.3rem;">Location Map (Google Maps)</h3>
          <div style="text-align: center;">
            <p style="text-align: center; margin: 0.5rem 0;">
              <a href="https://www.google.com/maps/search/?api=1&query=${lat},${lon}" target="_blank" style="color: #e67e22; text-decoration: none;">
                View on Google Maps
              </a>
            </p>
          </div>
        `;
      }

      const smsSummary = `Requesting a quote for remodel at ${addressDisplay.split(", ").slice(0, 2).join(", ")}: ${measurements.area}sqft, ${components.map(comp => comp.charAt(0).toUpperCase() + comp.slice(1) + (comp === "windows" ? ` (${windowDoorCount.windows})` : comp === "doors" ? ` (${windowDoorCount.doors})` : "")).join(", ")}, ~$${costEstimates.totalCostLow.toLocaleString()}–$${costEstimates.totalCostHigh.toLocaleString()}.`;
      resultsHtml += `
        <h3 style="color: #1a3c34; margin-bottom: 0.5rem; margin-top: 1.5rem; font-size: 1.3rem;">Next Steps with Indy Home Improvements</h3>
        <p style="margin: 0.5rem 0;">Ready to discuss your project? Contact us directly to request more info or a detailed quote.</p>
        <p style="font-size: 0.9rem; color: #666; margin: 0.5rem 0;">By clicking below, you agree to send an SMS to Indy Home Improvements at 765-366-3344. Standard messaging rates may apply. We will not share your phone number. Reply STOP to opt out.</p>
        <div style="text-align: center; margin: 1rem 0;">
          <a href="sms:7653663344?body=${encodeURIComponent(smsSummary)}" style="display: inline-block; padding: 0.75rem 1.5rem; background-color: #e67e22; color: white; text-decoration: none; border-radius: 4px; font-weight: bold; transition: background-color 0.3s;" aria-label="Contact Indy Home Improvements via SMS">Contact Us</a>
        </div>
      </div>
      `;

      const results = $("results");
      if (results) {
        results.innerHTML = resultsHtml;
      }

      // Ensure map container is hidden after form submission to prevent conflicts
      const mapContainer = $("mapContainer");
      if (mapContainer) {
        mapContainer.style.display = "none";
        console.log("Frontend - Map container hidden after form submission");
      }
    } catch (error) {
      console.error("Frontend - Fetch Error:", error);
      displayError(`Error: ${error.message}. Please try again or contact support.`);
    } finally {
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.innerHTML = "Get Estimate";
      }
    }
  });
}

// Photo Upload and Camera Capture Handlers
DIRECTIONS.forEach(direction => {
  const photoInput = $(`${direction}Photos`);
  if (photoInput) {
    photoInput.addEventListener("change", (e) => {
      const preview = $(`${direction}Preview`);
      if (preview) {
        preview.innerHTML = "";
        const files = Array.from(e.target.files);
        console.log(`Frontend - Selected ${files.length} files for ${direction} direction:`, files.map(file => file.name));
        files.forEach(file => {
          if (!file.type.startsWith("image/")) {
            return displayError(`Invalid file type for ${direction} photo. Please upload images (JPEG, PNG).`);
          }
          const img = createElement("img", {
            maxWidth: "150px",
            borderRadius: "4px",
            boxShadow: "0 2px 4px rgba(0, 0, 0, 0.1)",
            margin: "5px"
          }, { alt: `${direction} preview image`, src: URL.createObjectURL(file) });
          preview.appendChild(img);
        });
      }
    });
  }

  const captureButton = $(`capture${direction.charAt(0).toUpperCase() + direction.slice(1)}`);
  if (captureButton) {
    captureButton.addEventListener("click", async () => {
      let stream = null;
      let isBackCamera = true;
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(device => device.kind === "videoinput");
        console.log(`Frontend - Available video devices for ${direction}:`, videoDevices);

        let backCameraDeviceId = null;
        let frontCameraDeviceId = null;
        for (const device of videoDevices) {
          const label = device.label.toLowerCase();
          if (label.includes("back") || label.includes("rear") || label.includes("environment")) {
            backCameraDeviceId = device.deviceId;
          }
          if (label.includes("front") || label.includes("user")) {
            frontCameraDeviceId = device.deviceId;
          }
        }

        try {
          if (backCameraDeviceId) {
            console.log(`Frontend - Using back camera (deviceId: ${backCameraDeviceId}) for ${direction}`);
            stream = await navigator.mediaDevices.getUserMedia({
              video: { deviceId: { exact: backCameraDeviceId } },
              audio: false
            });
          } else {
            console.log(`Frontend - Back camera not explicitly found for ${direction}, using facingMode: "environment" with strict constraint`);
            stream = await navigator.mediaDevices.getUserMedia({
              video: { facingMode: { exact: "environment" } },
              audio: false
            });
          }
        } catch (backCameraError) {
          console.warn(`Frontend - Back camera unavailable for ${direction}:`, backCameraError);
          isBackCamera = false;

          if (frontCameraDeviceId) {
            console.log(`Frontend - Falling back to front camera (deviceId: ${frontCameraDeviceId}) for ${direction}`);
            stream = await navigator.mediaDevices.getUserMedia({
              video: { deviceId: { exact: frontCameraDeviceId } },
              audio: false
            });
          } else {
            console.log(`Frontend - Trying facingMode: "user" as fallback for ${direction}`);
            stream = await navigator.mediaDevices.getUserMedia({
              video: { facingMode: "user" },
              audio: false
            });
          }
        }

        const track = stream.getVideoTracks()[0];
        const settings = track.getSettings();
        console.log(`Frontend - Camera settings for ${direction}:`, settings);
        if (settings.facingMode === "user" && isBackCamera) {
          isBackCamera = false;
        }

        if (!isBackCamera) {
          displayWarning("Using front camera as the back camera is unavailable. Please ensure the photo captures the house exterior.");
        }

        const video = createElement("video", { maxWidth: "100%", borderRadius: "4px" }, { autoplay: "", playsinline: "" });
        video.srcObject = stream;

        const modal = createElement("div", {
          position: "fixed",
          top: "0",
          left: "0",
          width: "100%",
          height: "100%",
          background: "rgba(0, 0, 0, 0.8)",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          zIndex: "1000"
        });

        const container = createElement("div", {
          background: "white",
          padding: "20px",
          borderRadius: "8px",
          textAlign: "center"
        });
        container.appendChild(video);

        const captureButton = createElement("button", {
          marginTop: "10px",
          padding: "10px 20px",
          backgroundColor: "#e67e22",
          color: "white",
          border: "none",
          borderRadius: "4px",
          cursor: "pointer"
        });
        captureButton.innerText = "Capture Photo";
        container.appendChild(captureButton);

        const cancelButton = createElement("button", {
          marginTop: "10px",
          marginLeft: "10px",
          padding: "10px 20px",
          backgroundColor: "#d32f2f",
          color: "white",
          border: "none",
          borderRadius: "4px",
          cursor: "pointer"
        });
        cancelButton.innerText = "Cancel";
        container.appendChild(cancelButton);

        modal.appendChild(container);
        document.body.appendChild(modal);

        await new Promise(resolve => {
          video.onloadedmetadata = () => {
            video.play();
            resolve();
          };
        });

        captureButton.addEventListener("click", () => {
          const canvas = createElement("canvas");
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL("image/jpeg");

          const file = dataURLtoFile(dataUrl, `${direction}_photo.jpg`);
          const fileList = new DataTransfer();
          fileList.items.add(file);
          const photoInput = $(`${direction}Photos`);
          if (photoInput) {
            photoInput.files = fileList.files;
          }

          const preview = $(`${direction}Preview`);
          if (preview) {
            preview.innerHTML = "";
            const img = createElement("img", {
              maxWidth: "150px",
              borderRadius: "4px",
              boxShadow: "0 2px 4px rgba(0, 0, 0, 0.1)",
              margin: "5px"
            }, { alt: `${direction} captured image`, src: dataUrl });
            preview.appendChild(img);
          }

          stream.getTracks().forEach(track => track.stop());
          modal.remove();
        });

        cancelButton.addEventListener("click", () => {
          stream.getTracks().forEach(track => track.stop());
          modal.remove();
        });
      } catch (error) {
        console.error(`Frontend - Error accessing camera for ${direction}:`, error);
        let errorMessage = "Failed to access camera: " + error.message;
        if (error.name === "NotAllowedError") {
          errorMessage = "Camera access was denied. Please allow camera permissions in your browser settings.";
        } else if (error.name === "NotFoundError") {
          errorMessage = "No camera found on this device. Please upload an image instead.";
        }
        displayError(errorMessage);
      }
    });
  }
});