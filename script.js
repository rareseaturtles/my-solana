// Constants
const DIRECTIONS = ["north", "south", "east", "west"];
const IMAGE_SIZE_LIMIT = 500 * 1024; // 500KB
const IMAGE_PROCESSING_TIMEOUT = 10000; // 10 seconds

// Utility Functions
function $(id) {
  return document.getElementById(id);
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
  $("results").innerHTML = `
    <div style="background: white; border-radius: 8px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1); padding: 2rem; text-align: center;" role="alert">
      <p style="color: #d32f2f; margin: 0.5rem 0;">${message}</p>
      <p style="margin: 0.5rem 0;">Please try again or contact Indy Home Improvements at <a href="tel:7653663344" style="color: #e67e22; text-decoration: none;">765-366-3344</a> for assistance.</p>
    </div>
  `;
}

function displayWarning(message) {
  console.log("Frontend - Warning:", message);
  const resultsDiv = $("results");
  if (resultsDiv.innerHTML === "") {
    resultsDiv.innerHTML = `
      <div style="background: white; border-radius: 8px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1); padding: 2rem; text-align: center;" role="alert">
        <p style="color: #e67e22; margin: 0.5rem 0;">${message}</p>
      </div>
    `;
  }
}

function generateDynamicInputs(type, count, containerId) {
  const container = $(containerId);
  container.innerHTML = "";
  for (let i = 0; i < count; i++) {
    const div = createElement("div", { marginBottom: "10px" });
    div.innerHTML = `
      <label>${type} ${i + 1} Size (Width x Height in feet):</label>
      <input type="number" step="0.1" min="0" id="${type.toLowerCase()}Width${i}" placeholder="Width (e.g., 3)" style="width: 80px;" required>
      <span> x </span>
      <input type="number" step="0.1" min="0" id="${type.toLowerCase()}Height${i}" placeholder="Height (e.g., ${type === "Window" ? 4 : 7})" style="width: 80px;" required>
    `;
    container.appendChild(div);
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

// Dynamic Input Generation
$("windowCount").addEventListener("input", (e) => generateDynamicInputs("Window", parseInt(e.target.value) || 0, "windowSizes"));
$("doorCount").addEventListener("input", (e) => generateDynamicInputs("Door", parseInt(e.target.value) || 0, "doorSizes"));

// Form Submission Handler
$("remodelForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const submitButton = e.target.querySelector("button[type='submit']");
  submitButton.disabled = true;
  submitButton.innerHTML = "Processing...";

  try {
    const address = $("address").value.trim();
    const photos = {
      north: Array.from($("northPhotos").files),
      south: Array.from($("southPhotos").files),
      east: Array.from($("eastPhotos").files),
      west: Array.from($("westPhotos").files),
    };
    const retryPhotos = {
      north: Array.from($("northRetryPhotos")?.files || []),
      south: Array.from($("southRetryPhotos")?.files || []),
      east: Array.from($("eastRetryPhotos")?.files || []),
      west: Array.from($("westRetryPhotos")?.files || []),
    };
    const windowCount = parseInt($("windowCount").value) || null;
    const doorCount = parseInt($("doorCount").value) || null;

    // Validate Inputs
    if (!address) {
      throw new Error("Please enter a valid address.");
    }

    const windowSizes = [];
    if (windowCount) {
      for (let i = 0; i < windowCount; i++) {
        const width = parseFloat($(`windowWidth${i}`).value);
        const height = parseFloat($(`windowHeight${i}`).value);
        if (isNaN(width) || isNaN(height) || width <= 0 || height <= 0) {
          throw new Error(`Please provide valid dimensions for Window ${i + 1} (positive numbers).`);
        }
        windowSizes.push(`${width}ft x ${height}ft`);
      }
    }

    const doorSizes = [];
    if (doorCount) {
      for (let i = 0; i < doorCount; i++) {
        const width = parseFloat($(`doorWidth${i}`).value);
        const height = parseFloat($(`doorHeight${i}`).value);
        if (isNaN(width) || isNaN(height) || width <= 0 || height <= 0) {
          throw new Error(`Please provide valid dimensions for Door ${i + 1} (positive numbers).`);
        }
        doorSizes.push(`${width}ft x ${height}ft`);
      }
    }

    const totalImages = Object.values(photos).reduce((sum, arr) => sum + arr.length, 0) +
                        Object.values(retryPhotos).reduce((sum, arr) => sum + arr.length, 0);
    if (totalImages === 0 && windowCount === null && doorCount === null) {
      throw new Error("Please upload at least one photo for each direction or provide window and door counts.");
    }

    // Log Photo Inputs
    console.log("Frontend - Raw photo inputs:", Object.fromEntries(DIRECTIONS.map(dir => [dir, photos[dir].map(file => file.name)])));
    console.log("Frontend - Retry photo inputs:", Object.fromEntries(DIRECTIONS.map(dir => [dir, retryPhotos[dir].map(file => file.name)])));
    console.log(`Frontend - Total images selected: ${totalImages}`);

    // Warn About Multiple Images
    DIRECTIONS.forEach(direction => {
      if (photos[direction].length > 1) {
        displayWarning(`Multiple images uploaded for ${direction}. Only the first image will be processed for analysis, but all images will be saved.`);
      }
      $(`${direction}Retry`).style.display = "none";
    });

    // Convert Photos to Base64
    const resolvedPhotos = {};
    const resolvedRetryPhotos = {};
    for (const direction of DIRECTIONS) {
      resolvedPhotos[direction] = await convertPhotosToBase64(photos[direction], direction);
      resolvedRetryPhotos[direction] = await convertPhotosToBase64(retryPhotos[direction], `${direction}Retry`);
    }
    console.log("Frontend - Converted photos to base64:", Object.fromEntries(DIRECTIONS.map(dir => [dir, resolvedPhotos[dir].length])));
    console.log("Frontend - Converted retry photos to base64:", Object.fromEntries(DIRECTIONS.map(dir => [dir, resolvedRetryPhotos[dir].length])));

    // Send Request to Netlify Function
    $("results").innerHTML = `
      <div style="text-align: center;">
        <p>Loading... <span class="spinner" style="display: inline-block; width: 16px; height: 16px; border: 2px solid #e67e22; border-top-color: transparent; border-radius: 50%; animation: spin 1s linear infinite;"></p>
      </div>
      <style>
        @keyframes spin { to { transform: rotate(360deg); } }
      </style>
    `;

    console.log("Frontend - Sending request to /.netlify/functions/remodel with data:", { address, photos: resolvedPhotos, retryPhotos: resolvedRetryPhotos, windowCount, doorCount, windowSizes, doorSizes });
    const response = await fetch("/.netlify/functions/remodel", {
      method: "POST",
      body: JSON.stringify({ address, photos: resolvedPhotos, retryPhotos: resolvedRetryPhotos, windowCount, doorCount, windowSizes, doorSizes }),
    });
    console.log("Frontend - Response status:", response.status);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Server error: ${response.status} - ${text}`);
    }

    const result = await response.json();
    console.log("Frontend - Server Response:", result);
    if (result.error) throw new Error(result.error);

    // Handle Retry Directions
    if (result.retryDirections && result.retryDirections.length > 0) {
      result.retryDirections.forEach(direction => $(`${direction}Retry`).style.display = "block");
      throw new Error("Failed to detect windows or doors in some images. Please upload closer photos as requested and resubmit.");
    }

    // Process and Display Results
    const remodelId = result.remodelId || "unknown";
    const addressDisplay = result.addressData?.display_name || "Unknown Address";
    const measurements = result.measurements || { width: "N/A", length: "N/A", area: "N/A" };
    const isMeasurementsReliable = result.isMeasurementsReliable || false;
    const windowDoorCount = result.windowDoorCount || { windows: 0, doors: 0, windowSizes: [], doorSizes: [], isReliable: false };
    const isWindowDoorCountReliable = windowDoorCount.isReliable || false;
    const materialEstimates = result.materialEstimates || ["No estimates available"];
    const costEstimates = result.costEstimates || { totalCostLow: 0, totalCostHigh: 0, costBreakdown: ["No cost breakdown available"] };
    const timelineEstimate = result.timelineEstimate || "N/A";
    const roofInfo = result.roofInfo || { pitch: "N/A", height: "N/A", roofArea: "N/A", roofMaterial: "N/A", isPitchReliable: false, pitchSource: "default" };
    const processedImages = result.processedImages || {};
    const allUploadedImages = result.allUploadedImages || {};
    const lat = result.addressData?.lat || 0;
    const lon = result.addressData?.lon || 0;

    const isCostReliable = isMeasurementsReliable || isWindowDoorCountReliable;
    const hasValidCost = costEstimates && typeof costEstimates.totalCostLow === "number" && typeof costEstimates.totalCostHigh === "number" && costEstimates.totalCostLow > 0 && costEstimates.totalCostHigh > 0;
    console.log("Frontend - Cost rendering check:", { isCostReliable, hasValidCost, costEstimates });

    let resultsHtml = `
      <div style="background: white; border-radius: 8px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1); padding: 2rem;" role="region" aria-label="Remodel Estimate Results">
        <h2 style="color: #1a3c34; margin-bottom: 1rem; font-size: 1.8rem; text-align: center;">Remodel Estimate</h2>
        <h3 style="color: #1a3c34; margin-bottom: 0.5rem; font-size: 1.3rem;">Project Overview</h3>
        <p style="margin: 0.5rem 0;"><strong>Address:</strong> ${addressDisplay}</p>
        <p style="margin: 0.5rem 0;"><strong>Dimensions:</strong> ${measurements.width}ft x ${measurements.length}ft (Area: ${measurements.area} sq ft)</p>
        <p style="margin: 0.5rem 0;"><strong>Height (Est.):</strong> ${roofInfo.height}ft | <strong>Roof Pitch:</strong> ${roofInfo.pitch}</p>
        <p style="margin: 0.5rem 0;"><strong>Windows:</strong> ${windowDoorCount.windows} | <strong>Doors:</strong> ${windowDoorCount.doors}</p>
    `;

    if (!isMeasurementsReliable) {
      resultsHtml += `<p style="color: #d32f2f; font-size: 0.9rem; margin: 0.5rem 0;">Building dimensions are estimates due to limited data from OpenStreetMap. For accurate results, please verify the dimensions.</p>`;
    }

    if (!roofInfo.isPitchReliable) {
      let pitchMessage = "Roof pitch is a default estimate.";
      if (totalImages > 0) pitchMessage = "Roof pitch is a default estimate because the uploaded image could not be processed for analysis.";
      pitchMessage += " Please upload a clear photo showing the roof for a more accurate assessment.";
      resultsHtml += `<p style="color: #d32f2f; font-size: 0.9rem; margin: 0.5rem 0;">${pitchMessage}</p>`;
    } else {
      resultsHtml += `<p style="font-style: italic; color: #666; font-size: 0.9rem; margin: 0.5rem 0;">Roof pitch estimated from ${roofInfo.pitchSource === "user_image" ? "your uploaded photo" : "default"}.</p>`;
    }

    if (!isWindowDoorCountReliable && !windowCount && !doorCount) {
      resultsHtml += `<p style="color: #d32f2f; font-size: 0.9rem; margin: 0.5rem 0;">Window and door counts are estimates. For better accuracy, provide counts or upload clear photos.</p>`;
    }

    resultsHtml += `
      <h3 style="color: #1a3c34; margin-bottom: 0.5rem; margin-top: 1.5rem; font-size: 1.3rem;">Material Breakdown</h3>
      <ul style="list-style-type: disc; padding-left: 1.5rem; margin-bottom: 1rem;">${materialEstimates.map(item => `<li>${item}</li>`).join("")}</ul>
      <h3 style="color: #1a3c34; margin-bottom: 0.5rem; margin-top: 1.5rem; font-size: 1.3rem;">Cost Estimate (Approximate)</h3>
    `;

    if (isCostReliable && hasValidCost) {
      resultsHtml += `
        <p style="margin: 0.5rem 0;"><strong>Total:</strong> $${costEstimates.totalCostLow.toLocaleString()}–$${costEstimates.totalCostHigh.toLocaleString()}</p>
        <ul style="list-style-type: disc; padding-left: 1.5rem; margin-bottom: 1rem;">${costEstimates.costBreakdown.map(item => `<li>${item}</li>`).join("")}</ul>
        <p style="font-style: italic; color: #666; font-size: 0.9rem; margin: 0.5rem 0;">Costs are approximate and may vary based on final measurements, material prices, labor rates, and location-specific factors.</p>
      `;
      if (!isMeasurementsReliable || !isWindowDoorCountReliable) {
        resultsHtml += `<p style="color: #d32f2f; font-size: 0.9rem; margin: 0.5rem 0;">This estimate is based on partial data. For a more accurate estimate, upload clear photos or provide window/door counts.</p>`;
      }
    } else {
      resultsHtml += `<p style="color: #d32f2f; margin: 0.5rem 0;">Cost estimate unavailable. Please provide manual counts and sizes or upload clear photos of the house exterior.</p>`;
      console.log("Frontend - Cost estimate display fallback triggered. isCostReliable:", isCostReliable, "hasValidCost:", hasValidCost);
    }

    resultsHtml += `
      <h3 style="color: #1a3c34; margin-bottom: 0.5rem; margin-top: 1.5rem; font-size: 1.3rem;">Estimated Timeline</h3>
      <p style="margin: 0.5rem 0;">${timelineEstimate} weeks</p>
      <p style="font-style: italic; color: #666; font-size: 0.9rem; margin: 0.5rem 0;">Timeline depends on project scope, weather, and crew availability.</p>
      <h3 style="color: #1a3c34; margin-bottom: 0.5rem; margin-top: 1.5rem; font-size: 1.3rem;">Permit Information</h3>
      <p style="margin: 0.5rem 0;">Remodeling in your area may require permits for structural, electrical, or plumbing work. Contact your local building department.</p>
      <p style="margin: 0.5rem 0;"><a href="https://www.usa.gov/local-building-permits" target="_blank" style="color: #e67e22; text-decoration: none;">Learn More About Permits</a></p>
    `;

    DIRECTIONS.forEach(direction => {
      if (processedImages[direction]) {
        resultsHtml += `
          <h3 style="color: #1a3c34; margin-bottom: 0.5rem; margin-top: 1.5rem; font-size: 1.3rem;">${direction.charAt(0).toUpperCase() + direction.slice(1)}-Facing Image (Processed)</h3>
          <div style="text-align: center;">
            <img src="${processedImages[direction]}" alt="${direction} House Image" style="max-width: 100%; border-radius: 8px; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1); margin: 1rem 0;">
          </div>
        `;
      }
      if (allUploadedImages[direction] && allUploadedImages[direction].length > 0) {
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

    if (totalImages > 0) {
      if (windowDoorCount.windows === 0 && windowDoorCount.doors === 0 && !windowCount && !doorCount) {
        resultsHtml += `<p style="color: #d32f2f; font-size: 0.9rem; margin: 0.5rem 0;">Failed to detect windows or doors in uploaded image(s). Please upload clear photos of the house exterior or provide manual counts and sizes.</p>`;
      } else {
        resultsHtml += `<p style="font-style: italic; color: #666; font-size: 0.9rem; margin: 0.5rem 0;">Processed ${Object.values(processedImages).length} user-uploaded image(s) for window and door detection. Up to 1 image per direction is processed.</p>`;
      }
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

    const smsSummary = `Remodel at ${addressDisplay}: ${measurements.area}sqft, ${windowDoorCount.windows} windows, ${windowDoorCount.doors} doors, ~$${costEstimates.totalCostLow.toLocaleString()}–$${costEstimates.totalCostHigh.toLocaleString()}. Contact Indy Home Improvements for a detailed quote.`;
    resultsHtml += `
      <h3 style="color: #1a3c34; margin-bottom: 0.5rem; margin-top: 1.5rem; font-size: 1.3rem;">Next Steps with Indy Home Improvements</h3>
      <p style="margin: 0.5rem 0;">Ready to discuss your project? Contact us directly to request more info or a detailed quote.</p>
      <p style="font-size: 0.9rem; color: #666; margin: 0.5rem 0;">By clicking below, you agree to send an SMS to Indy Home Improvements at 765-366-3344. Standard messaging rates may apply. We will not share your phone number. Reply STOP to opt out.</p>
      <div style="text-align: center; margin: 1rem 0;">
        <a href="sms:7653663344?body=${encodeURIComponent(smsSummary)}" style="display: inline-block; padding: 0.75rem 1.5rem; background-color: #e67e22; color: white; text-decoration: none; border-radius: 4px; font-weight: bold; transition: background-color 0.3s;" aria-label="Contact Indy Home Improvements via SMS">Contact Us</a>
      </div>
    </div>
    `;

    $("results").innerHTML = resultsHtml;
  } catch (error) {
    console.error("Frontend - Fetch Error:", error);
    displayError(`Error: ${error.message}. Please try again or contact support.`);
  } finally {
    submitButton.disabled = false;
    submitButton.innerHTML = "Get Estimate";
  }
});

// Photo Upload and Camera Capture Handlers
DIRECTIONS.forEach(direction => {
  // Handle File Uploads
  $(`${direction}Photos`).addEventListener("change", (e) => {
    const preview = $(`${direction}Preview`);
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
  });

  // Handle Retry Uploads
  const retryInput = $(`${direction}RetryPhotos`);
  if (retryInput) {
    retryInput.addEventListener("change", (e) => {
      const preview = $(`${direction}RetryPreview`);
      preview.innerHTML = "";
      const files = Array.from(e.target.files);
      console.log(`Frontend - Selected ${files.length} retry files for ${direction} direction:`, files.map(file => file.name));
      files.forEach(file => {
        if (!file.type.startsWith("image/")) {
          return displayError(`Invalid file type for ${direction} retry photo. Please upload images (JPEG, PNG).`);
        }
        const img = createElement("img", {
          maxWidth: "150px",
          borderRadius: "4px",
          boxShadow: "0 2px 4px rgba(0, 0, 0, 0.1)",
          margin: "5px"
        }, { alt: `${direction} retry preview image`, src: URL.createObjectURL(file) });
        preview.appendChild(img);
      });
    });
  }

  // Handle Camera Capture
  $(`capture${direction.charAt(0).toUpperCase() + direction.slice(1)}`).addEventListener("click", async () => {
    let stream = null;
    try {
      // Step 1: Enumerate devices for debugging
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter(device => device.kind === "videoinput");
      console.log(`Frontend - Available video devices for ${direction}:`, videoDevices);

      // Step 2: Find the back camera by deviceId
      let backCameraDeviceId = null;
      for (const device of videoDevices) {
        if (device.label.toLowerCase().includes("back") || device.label.toLowerCase().includes("rear") || device.label.toLowerCase().includes("environment")) {
          backCameraDeviceId = device.deviceId;
          break;
        }
      }

      // Step 3: Request the video stream with strict back camera constraints
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

      // Step 4: Verify we got the back camera
      const track = stream.getVideoTracks()[0];
      const settings = track.getSettings();
      console.log(`Frontend - Camera settings for ${direction}:`, settings);
      if (settings.facingMode !== "environment") {
        stream.getTracks().forEach(track => track.stop());
        throw new Error("Selected camera is not the back camera. This feature requires the back camera to photograph the house.");
      }

      // Step 5: Set up the video element
      const video = createElement("video", { maxWidth: "100%", borderRadius: "4px" }, { autoplay: "", playsinline: "" });
      video.srcObject = stream;

      // Step 6: Create a modal for capturing the photo
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

      // Wait for video to be ready
      await new Promise(resolve => {
        video.onloadedmetadata = () => {
          video.play();
          resolve();
        };
      });

      // Step 7: Capture the photo
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
        $(`${direction}Photos`).files = fileList.files;

        const preview = $(`${direction}Preview`);
        preview.innerHTML = "";
        const img = createElement("img", {
          maxWidth: "150px",
          borderRadius: "4px",
          boxShadow: "0 2px 4px rgba(0, 0, 0, 0.1)",
          margin: "5px"
        }, { alt: `${direction} captured image`, src: dataUrl });
        preview.appendChild(img);

        stream.getTracks().forEach(track => track.stop());
        modal.remove();
      });

      cancelButton.addEventListener("click", () => {
        stream.getTracks().forEach(track => track.stop());
        modal.remove();
      });

    } catch (error) {
      console.error(`Frontend - Error accessing camera for ${direction}:`, error);
      let errorMessage = "Failed to access the back camera: " + error.message;
      if (error.name === "OverconstrainedError" || error.message.includes("not the back camera")) {
        errorMessage = "This feature requires the back camera to photograph the house, but it's not available. Please use a device with a back camera or upload an image instead.";
      } else if (error.name === "NotAllowedError") {
        errorMessage = "Camera access was denied. Please allow camera permissions in your browser settings.";
      }
      displayError(errorMessage);
    }
  });
});