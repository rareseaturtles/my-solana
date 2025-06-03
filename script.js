// Dynamic input generation for windows
document.getElementById("windowCount").addEventListener("input", (e) => {
  const count = parseInt(e.target.value) || 0;
  const windowSizesDiv = document.getElementById("windowSizes");
  windowSizesDiv.innerHTML = "";
  for (let i = 0; i < count; i++) {
    windowSizesDiv.innerHTML += `
      <div style="margin-bottom: 10px;">
        <label>Window ${i + 1} Size (Width x Height in feet):</label>
        <input type="number" step="0.1" min="0" id="windowWidth${i}" placeholder="Width (e.g., 3)" style="width: 80px;" required>
        <span> x </span>
        <input type="number" step="0.1" min="0" id="windowHeight${i}" placeholder="Height (e.g., 4)" style="width: 80px;" required>
      </div>
    `;
  }
});

// Dynamic input generation for doors
document.getElementById("doorCount").addEventListener("input", (e) => {
  const count = parseInt(e.target.value) || 0;
  const doorSizesDiv = document.getElementById("doorSizes");
  doorSizesDiv.innerHTML = "";
  for (let i = 0; i < count; i++) {
    doorSizesDiv.innerHTML += `
      <div style="margin-bottom: 10px;">
        <label>Door ${i + 1} Size (Width x Height in feet):</label>
        <input type="number" step="0.1" min="0" id="doorWidth${i}" placeholder="Width (e.g., 3)" style="width: 80px;" required>
        <span> x </span>
        <input type="number" step="0.1" min="0" id="doorHeight${i}" placeholder="Height (e.g., 7)" style="width: 80px;" required>
      </div>
    `;
  }
});

// Form submission handler
document.getElementById("remodelForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const submitButton = e.target.querySelector("button[type='submit']");
  submitButton.disabled = true;
  submitButton.innerHTML = "Processing...";

  const address = document.getElementById("address").value.trim();
  const photos = {
    north: Array.from(document.getElementById("northPhotos").files),
    south: Array.from(document.getElementById("southPhotos").files),
    east: Array.from(document.getElementById("eastPhotos").files),
    west: Array.from(document.getElementById("westPhotos").files),
  };
  const retryPhotos = {
    north: Array.from(document.getElementById("northRetryPhotos")?.files || []),
    south: Array.from(document.getElementById("southRetryPhotos")?.files || []),
    east: Array.from(document.getElementById("eastRetryPhotos")?.files || []),
    west: Array.from(document.getElementById("westRetryPhotos")?.files || []),
  };
  const windowCount = parseInt(document.getElementById("windowCount").value) || null;
  const doorCount = parseInt(document.getElementById("doorCount").value) || null;

  // Validate window sizes
  const windowSizes = [];
  if (windowCount) {
    for (let i = 0; i < windowCount; i++) {
      const width = parseFloat(document.getElementById(`windowWidth${i}`).value);
      const height = parseFloat(document.getElementById(`windowHeight${i}`).value);
      if (isNaN(width) || isNaN(height) || width <= 0 || height <= 0) {
        displayError(`Please provide valid dimensions for Window ${i + 1} (positive numbers).`);
        submitButton.disabled = false;
        submitButton.innerHTML = "Get Estimate";
        return;
      }
      windowSizes.push(`${width}ft x ${height}ft`);
    }
  }

  // Validate door sizes
  const doorSizes = [];
  if (doorCount) {
    for (let i = 0; i < doorCount; i++) {
      const width = parseFloat(document.getElementById(`doorWidth${i}`).value);
      const height = parseFloat(document.getElementById(`doorHeight${i}`).value);
      if (isNaN(width) || isNaN(height) || width <= 0 || height <= 0) {
        displayError(`Please provide valid dimensions for Door ${i + 1} (positive numbers).`);
        submitButton.disabled = false;
        submitButton.innerHTML = "Get Estimate";
        return;
      }
      doorSizes.push(`${width}ft x ${height}ft`);
    }
  }

  // Validate address
  if (!address) {
    displayError("Please enter a valid address.");
    submitButton.disabled = false;
    submitButton.innerHTML = "Get Estimate";
    return;
  }

  // Validate at least one photo or manual counts
  const totalImages = Object.values(photos).reduce((sum, arr) => sum + arr.length, 0) +
                      Object.values(retryPhotos).reduce((sum, arr) => sum + arr.length, 0);
  if (totalImages === 0 && windowCount === null && doorCount === null) {
    displayError("Please upload at least one photo for each direction or provide window and door counts.");
    submitButton.disabled = false;
    submitButton.innerHTML = "Get Estimate";
    return;
  }

  // Log photo inputs
  console.log("Frontend - Raw photo inputs:", {
    north: photos.north.map(file => file.name),
    south: photos.south.map(file => file.name),
    east: photos.east.map(file => file.name),
    west: photos.west.map(file => file.name),
  });
  console.log("Frontend - Retry photo inputs:", {
    north: retryPhotos.north.map(file => file.name),
    south: retryPhotos.south.map(file => file.name),
    east: retryPhotos.east.map(file => file.name),
    west: retryPhotos.west.map(file => file.name),
  });
  console.log(`Frontend - Total images selected: ${totalImages}`);

  // Warn about multiple images per direction
  const directions = ["north", "south", "east", "west"];
  for (const direction of directions) {
    if (photos[direction].length > 1) {
      displayWarning(`Multiple images uploaded for ${direction}. Only the first image will be processed for analysis, but all images will be saved.`);
    }
    document.getElementById(`${direction}Retry`).style.display = "none";
  }

  // Convert photos to base64
  let resolvedPhotos, resolvedRetryPhotos;
  try {
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Image processing timed out. Please try uploading smaller images.")), 10000);
    });

    const convertDirection = async (directionFiles, direction) => {
      const results = [];
      for (const file of directionFiles) {
        try {
          if (file.size > 500 * 1024) {
            throw new Error(`Image ${file.name} exceeds 500KB. Please upload a smaller image.`);
          }
          const base64 = await fileToBase64(file);
          results.push(base64);
        } catch (error) {
          console.error(`Frontend - Error converting ${direction} photo: ${error.message}`);
          throw new Error(`${direction.charAt(0).toUpperCase() + direction.slice(1)} photo: ${error.message}`);
        }
      }
      return results;
    };

    resolvedPhotos = {
      north: await Promise.race([convertDirection(photos.north, "north"), timeoutPromise]),
      south: await Promise.race([convertDirection(photos.south, "south"), timeoutPromise]),
      east: await Promise.race([convertDirection(photos.east, "east"), timeoutPromise]),
      west: await Promise.race([convertDirection(photos.west, "west"), timeoutPromise]),
    };

    resolvedRetryPhotos = {
      north: await Promise.race([convertDirection(retryPhotos.north, "northRetry"), timeoutPromise]),
      south: await Promise.race([convertDirection(retryPhotos.south, "southRetry"), timeoutPromise]),
      east: await Promise.race([convertDirection(retryPhotos.east, "eastRetry"), timeoutPromise]),
      west: await Promise.race([convertDirection(retryPhotos.west, "westRetry"), timeoutPromise]),
    };

    console.log("Frontend - Converted photos to base64:", Object.keys(resolvedPhotos).map(dir => `${dir}: ${resolvedPhotos[dir].length}`).join(", "));
    console.log("Frontend - Converted retry photos to base64:", Object.keys(resolvedRetryPhotos).map(dir => `${dir}: ${resolvedRetryPhotos[dir].length}`).join(", "));
  } catch (error) {
    console.error("Frontend - Error converting images to base64:", error.message);
    displayError(`Failed to process uploaded images: ${error.message}. Please ensure they are valid image files (JPEG, PNG) and try again.`);
    submitButton.disabled = false;
    submitButton.innerHTML = "Get Estimate";
    return;
  }

  // Send request to Netlify function
  try {
    document.getElementById("results").innerHTML = `
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
      body: JSON.stringify({
        address,
        photos: resolvedPhotos,
        retryPhotos: resolvedRetryPhotos,
        windowCount,
        doorCount,
        windowSizes,
        doorSizes,
      }),
    });
    console.log("Frontend - Response status:", response.status);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Server error: ${response.status} - ${text}`);
    }

    let result;
    try {
      result = await response.json();
    } catch (jsonError) {
      const text = await response.text();
      throw new Error(`Failed to parse response as JSON: ${text}`);
    }

    console.log("Frontend - Server Response:", result);

    if (result.error) throw new Error(result.error);

    if (result.retryDirections && result.retryDirections.length > 0) {
      result.retryDirections.forEach(direction => {
        document.getElementById(`${direction}Retry`).style.display = "block";
      });
      displayError("Failed to detect windows or doors in some images. Please upload closer photos as requested and resubmit.");
      submitButton.disabled = false;
      submitButton.innerHTML = "Get Estimate";
      return;
    }

    // Process and display results
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
      resultsHtml += `
        <p style="color: #d32f2f; font-size: 0.9rem; margin: 0.5rem 0;">Building dimensions are estimates due to limited data from OpenStreetMap. For accurate results, please verify the dimensions.</p>
      `;
    }

    if (!roofInfo.isPitchReliable) {
      let pitchMessage = "Roof pitch is a default estimate.";
      if (totalImages > 0) {
        pitchMessage = "Roof pitch is a default estimate because the uploaded image could not be processed for analysis.";
      }
      pitchMessage += " Please upload a clear photo showing the roof for a more accurate assessment.";
      resultsHtml += `
        <p style="color: #d32f2f; font-size: 0.9rem; margin: 0.5rem 0;">${pitchMessage}</p>
      `;
    } else {
      resultsHtml += `
        <p style="font-style: italic; color: #666; font-size: 0.9rem; margin: 0.5rem 0;">Roof pitch estimated from ${roofInfo.pitchSource === "user_image" ? "your uploaded photo" : "default"}.</p>
      `;
    }

    if (!isWindowDoorCountReliable && !windowCount && !doorCount) {
      resultsHtml += `
        <p style="color: #d32f2f; font-size: 0.9rem; margin: 0.5rem 0;">Window and door counts are estimates. For better accuracy, provide counts or upload clear photos.</p>
      `;
    }

    resultsHtml += `
      <h3 style="color: #1a3c34; margin-bottom: 0.5rem; margin-top: 1.5rem; font-size: 1.3rem;">Material Breakdown</h3>
      <ul style="list-style-type: disc; padding-left: 1.5rem; margin-bottom: 1rem;">${materialEstimates.map(item => `<li>${item}</li>`).join("")}</ul>
      <h3 style="color: #1a3c34; margin-bottom: 0.5rem; margin-top: 1.5rem; font-size: 1.3rem;">Cost Estimate (Approximate)</h3>
    `;

    // Ensure cost estimates are valid numbers and greater than 0
    const hasValidCost = costEstimates && typeof costEstimates.totalCostLow === "number" && typeof costEstimates.totalCostHigh === "number" && costEstimates.totalCostLow > 0 && costEstimates.totalCostHigh > 0;

    if (isCostReliable && hasValidCost) {
      resultsHtml += `
        <p style="margin: 0.5rem 0;"><strong>Total:</strong> $${costEstimates.totalCostLow.toLocaleString()}–$${costEstimates.totalCostHigh.toLocaleString()}</p>
        <ul style="list-style-type: disc; padding-left: 1.5rem; margin-bottom: 1rem;">${costEstimates.costBreakdown.map(item => `<li>${item}</li>`).join("")}</ul>
        <p style="font-style: italic; color: #666; font-size: 0.9rem; margin: 0.5rem 0;">Costs are approximate and may vary based on final measurements, material prices, labor rates, and location-specific factors.</p>
      `;
      if (!isMeasurementsReliable || !isWindowDoorCountReliable) {
        resultsHtml += `
          <p style="color: #d32f2f; font-size: 0.9rem; margin: 0.5rem 0;">This estimate is based on partial data. For a more accurate estimate, upload clear photos or provide window/door counts.</p>
        `;
      }
    } else {
      resultsHtml += `
        <p style="color: #d32f2f; margin: 0.5rem 0;">Cost estimate unavailable. Please provide manual counts and sizes or upload clear photos of the house exterior.</p>
      `;
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

    for (const direction of directions) {
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
    }

    if (totalImages > 0) {
      if (windowDoorCount.windows === 0 && windowDoorCount.doors === 0 && !windowCount && !doorCount) {
        resultsHtml += `
          <p style="color: #d32f2f; font-size: 0.9rem; margin: 0.5rem 0;">Failed to detect windows or doors in uploaded image(s). Please upload clear photos of the house exterior or provide manual counts and sizes.</p>
        `;
      } else {
        resultsHtml += `
          <p style="font-style: italic; color: #666; font-size: 0.9rem; margin: 0.5rem 0;">Processed ${Object.values(processedImages).length} user-uploaded image(s) for window and door detection. Up to 1 image per direction is processed.</p>
        `;
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

    document.getElementById("results").innerHTML = resultsHtml;
  } catch (error) {
    console.error("Frontend - Fetch Error:", error);
    displayError(`Error: ${error.message}. Please try again or contact support.`);
  } finally {
    submitButton.disabled = false;
    submitButton.innerHTML = "Get Estimate";
  }
});

// Photo upload and camera capture handlers
const directions = ["north", "south", "east", "west"];
directions.forEach(direction => {
  document.getElementById(`${direction}Photos`).addEventListener("change", (e) => {
    const preview = document.getElementById(`${direction}Preview`);
    preview.innerHTML = "";
    const files = Array.from(e.target.files);
    console.log(`Frontend - Selected ${files.length} files for ${direction} direction:`, files.map(file => file.name));
    files.forEach(file => {
      if (!file.type.startsWith("image/")) {
        displayError(`Invalid file type for ${direction} photo. Please upload images (JPEG, PNG).`);
        return;
      }
      const img = document.createElement("img");
      img.src = URL.createObjectURL(file);
      img.style.maxWidth = "150px";
      img.style.borderRadius = "4px";
      img.style.boxShadow = "0 2px 4px rgba(0, 0, 0, 0.1)";
      img.style.margin = "5px";
      img.alt = `${direction} preview image`;
      preview.appendChild(img);
    });
  });

  const retryInput = document.getElementById(`${direction}RetryPhotos`);
  if (retryInput) {
    retryInput.addEventListener("change", (e) => {
      const preview = document.getElementById(`${direction}RetryPreview`);
      preview.innerHTML = "";
      const files = Array.from(e.target.files);
      console.log(`Frontend - Selected ${files.length} retry files for ${direction} direction:`, files.map(file => file.name));
      files.forEach(file => {
        if (!file.type.startsWith("image/")) {
          displayError(`Invalid file type for ${direction} retry photo. Please upload images (JPEG, PNG).`);
          return;
        }
        const img = document.createElement("img");
        img.src = URL.createObjectURL(file);
        img.style.maxWidth = "150px";
        img.style.borderRadius = "4px";
        img.style.boxShadow = "0 2px 4px rgba(0, 0, 0, 0.1)";
        img.style.margin = "5px";
        img.alt = `${direction} retry preview image`;
        preview.appendChild(img);
      });
    });
  }

  document.getElementById(`capture${direction.charAt(0).toUpperCase() + direction.slice(1)}`).addEventListener("click", async () => {
    try {
      // Enumerate devices to find the back-facing camera
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter(device => device.kind === "videoinput");
      console.log(`Frontend - Available video devices for ${direction}:`, videoDevices);

      let backCameraDeviceId = null;
      for (const device of videoDevices) {
        // Look for labels indicating a back camera; fallback to regex if needed
        if (device.label.toLowerCase().includes("back") || device.label.toLowerCase().includes("rear")) {
          backCameraDeviceId = device.deviceId;
          break;
        }
      }

      let stream;
      if (backCameraDeviceId) {
        console.log(`Frontend - Using back camera (deviceId: ${backCameraDeviceId}) for ${direction}`);
        stream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: backCameraDeviceId } }
        });
      } else {
        console.warn(`Frontend - Back camera not found for ${direction}, falling back to default camera`);
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" }
        });
      }

      const video = document.createElement("video");
      video.srcObject = stream;
      video.play();

      const modal = document.createElement("div");
      modal.style.position = "fixed";
      modal.style.top = "0";
      modal.style.left = "0";
      modal.style.width = "100%";
      modal.style.height = "100%";
      modal.style.background = "rgba(0, 0, 0, 0.8)";
      modal.style.display = "flex";
      modal.style.justifyContent = "center";
      modal.style.alignItems = "center";
      modal.style.zIndex = "1000";

      const container = document.createElement("div");
      container.style.background = "white";
      container.style.padding = "20px";
      container.style.borderRadius = "8px";
      container.style.textAlign = "center";

      video.style.maxWidth = "100%";
      video.style.borderRadius = "4px";
      container.appendChild(video);

      const captureButton = document.createElement("button");
      captureButton.innerText = "Capture Photo";
      captureButton.style.marginTop = "10px";
      captureButton.style.padding = "10px 20px";
      captureButton.style.backgroundColor = "#e67e22";
      captureButton.style.color = "white";
      captureButton.style.border = "none";
      captureButton.style.borderRadius = "4px";
      captureButton.style.cursor = "pointer";
      container.appendChild(captureButton);

      const cancelButton = document.createElement("button");
      cancelButton.innerText = "Cancel";
      cancelButton.style.marginTop = "10px";
      cancelButton.style.marginLeft = "10px";
      cancelButton.style.padding = "10px 20px";
      cancelButton.style.backgroundColor = "#d32f2f";
      cancelButton.style.color = "white";
      cancelButton.style.border = "none";
      cancelButton.style.borderRadius = "4px";
      cancelButton.style.cursor = "pointer";
      container.appendChild(cancelButton);

      modal.appendChild(container);
      document.body.appendChild(modal);

      captureButton.addEventListener("click", () => {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/jpeg");

        const file = dataURLtoFile(dataUrl, `${direction}_photo.jpg`);
        const fileList = new DataTransfer();
        fileList.items.add(file);
        document.getElementById(`${direction}Photos`).files = fileList.files;

        const preview = document.getElementById(`${direction}Preview`);
        preview.innerHTML = "";
        const img = document.createElement("img");
        img.src = dataUrl;
        img.style.maxWidth = "150px";
        img.style.borderRadius = "4px";
        img.style.boxShadow = "0 2px 4px rgba(0, 0, 0, 0.1)";
        img.style.margin = "5px";
        img.alt = `${direction} captured image`;
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
      displayError(`Failed to access camera: ${error.message}. Please ensure camera permissions are granted and try using the back camera, or upload an image instead.`);
    }
  });
});

// Utility functions
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith("image/")) {
      reject(new Error("Invalid file type. Please upload images (JPEG, PNG)."));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      console.log(`Frontend - Converted file ${file.name} to base64, length: ${reader.result.length}`);
      if (!reader.result || typeof reader.result !== "string") {
        reject(new Error(`Failed to convert ${file.name} to base64.`));
        return;
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
  while (n--) {
    u8arr[n] = bstr.charCodeAt(n);
  }
  return new File([u8arr], filename, { type: mime });
}

function displayError(message) {
  document.getElementById("results").innerHTML = `
    <div style="background: white; border-radius: 8px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1); padding: 2rem; text-align: center;" role="alert">
      <p style="color: #d32f2f; margin: 0.5rem 0;">${message}</p>
      <p style="margin: 0.5rem 0;">Please try again or contact Indy Home Improvements at <a href="tel:7653663344" style="color: #e67e22; text-decoration: none;">765-366-3344</a> for assistance.</p>
    </div>
  `;
}

function displayWarning(message) {
  console.log("Frontend - Warning:", message);
  const resultsDiv = document.getElementById("results");
  if (resultsDiv.innerHTML === "") {
    resultsDiv.innerHTML = `
      <div style="background: white; border-radius: 8px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1); padding: 2rem; text-align: center;" role="alert">
        <p style="color: #e67e22; margin: 0.5rem 0;">${message}</p>
      </div>
    `;
  }
}