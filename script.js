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
  const windowCount = document.getElementById("windowCount").value || null;
  const doorCount = document.getElementById("doorCount").value || null;

  if (!address) {
    displayError("Please enter a valid address.");
    submitButton.disabled = false;
    submitButton.innerHTML = "Get Estimate";
    return;
  }

  console.log("Raw photo inputs:", {
    north: photos.north.map(file => file.name),
    south: photos.south.map(file => file.name),
    east: photos.east.map(file => file.name),
    west: photos.west.map(file => file.name),
  });

  const totalImages = Object.values(photos).reduce((sum, arr) => sum + arr.length, 0);
  console.log(`Total images selected: ${totalImages}`);

  const directions = ["north", "south", "east", "west"];
  for (const direction of directions) {
    if (photos[direction].length > 1) {
      displayWarning(`Multiple images uploaded for ${direction}. Only the first image will be processed for analysis, but all images will be saved.`);
    }
  }

  let resolvedPhotos;
  try {
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Image processing timed out. Please try uploading smaller images.")), 10000);
    });

    const convertDirection = async (directionFiles, direction) => {
      const results = [];
      for (const file of directionFiles) {
        try {
          const base64 = await fileToBase64(file);
          results.push(base64);
        } catch (error) {
          console.error(`Error converting ${direction} photo: ${error.message}`);
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
    console.log("Converted photos to base64:", Object.keys(resolvedPhotos).map(dir => `${dir}: ${resolvedPhotos[dir].length}`).join(", "));
  } catch (error) {
    console.error("Error converting images to base64:", error.message);
    displayError(`Failed to process uploaded images: ${error.message}. Please ensure they are valid image files (JPEG, PNG) and try again.`);
    submitButton.disabled = false;
    submitButton.innerHTML = "Get Estimate";
    return;
  }

  try {
    document.getElementById("results").innerHTML = `
      <div style="text-align: center;">
        <p>Loading... <span class="spinner" style="display: inline-block; width: 16px; height: 16px; border: 2px solid #e67e22; border-top-color: transparent; border-radius: 50%; animation: spin 1s linear infinite;"></p>
      </div>
      <style>
        @keyframes spin { to { transform: rotate(360deg); } }
      </style>
    `;

    console.log("Sending request to /.netlify/functions/remodel with data:", { address, photos: resolvedPhotos, windowCount, doorCount });
    const response = await fetch("/.netlify/functions/remodel", {
      method: "POST",
      body: JSON.stringify({
        address,
        photos: resolvedPhotos,
        windowCount,
        doorCount,
      }),
    });
    console.log("Response status:", response.status);

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

    if (result.error) throw new Error(result.error);

    const remodelId = result.remodelId || "unknown";
    const addressDisplay = result.addressData?.display_name || "Unknown Address";
    const measurements = result.measurements || { width: "N/A", length: "N/A", area: "N/A" };
    const isMeasurementsReliable = result.isMeasurementsReliable || false;
    const windowDoorCount = result.windowDoorCount || { windows: 0, doors: 0, windowSizes: [], doorSizes: [], isReliable: false };
    const isWindowDoorCountReliable = windowDoorCount.isReliable || false;
    const materialEstimates = result.materialEstimates || ["No estimates available"];
    const costEstimates = result.costEstimates || { totalCost: "N/A", costBreakdown: ["No cost breakdown available"] };
    const timelineEstimate = result.timelineEstimate || "N/A";
    const roofInfo = result.roofInfo || { pitch: "N/A", height: "N/A", roofArea: "N/A", roofMaterial: "N/A", isPitchReliable: false, pitchSource: "default" };
    const processedImages = result.processedImages || {};
    const allUploadedImages = result.allUploadedImages || {};
    const satelliteImage = result.satelliteImage || null;
    const satelliteImageError = result.satelliteImageError || null;
    const usedStreetView = result.usedStreetView || false;
    const streetViewStatus = result.streetViewStatus || "not_used";
    const streetViewRoofPitchStatus = result.streetViewRoofPitchStatus || "not_attempted";
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
      if (roofInfo.pitchSource === "street_view_failed") {
        pitchMessage += ` Street View imagery was ${streetViewRoofPitchStatus === "unavailable" ? "not available" : "attempted but failed"} for roof pitch estimation.`;
      } else if (roofInfo.pitchSource === "satellite_failed") {
        pitchMessage += " Satellite imagery analysis failed to detect the roof.";
      }
      pitchMessage += " Please upload a clear photo showing the roof for a more accurate assessment.";
      resultsHtml += `
        <p style="color: #d32f2f; font-size: 0.9rem; margin: 0.5rem 0;">${pitchMessage}</p>
      `;
    } else {
      resultsHtml += `
        <p style="font-style: italic; color: #666; font-size: 0.9rem; margin: 0.5rem 0;">Roof pitch estimated from ${roofInfo.pitchSource === "user_image" ? "your uploaded photo" : roofInfo.pitchSource === "street_view" ? "Street View imagery" : "satellite imagery"}.</p>
      `;
    }

    if (usedStreetView) {
      if (streetViewStatus === "success") {
        resultsHtml += `
          <p style="font-style: italic; color: #666; font-size: 0.9rem; margin: 0.5rem 0;">Used Google Street View images for window and door detection due to no user-uploaded photos.</p>
        `;
      } else {
        let reason = streetViewStatus === "unavailable" ? "Street View imagery is not available for this location." :
                     streetViewStatus === "api_key_missing" ? "Google Maps API key is missing." :
                     "Failed to fetch Street View imagery.";
        resultsHtml += `
          <p style="color: #d32f2f; font-size: 0.9rem; margin: 0.5rem 0;">${reason} Default window/door counts were used. Please upload photos for better accuracy.</p>
        `;
      }
    }

    if (!isWindowDoorCountReliable && !windowCount && !doorCount) {
      resultsHtml += `
        <p style="color: #d32f2f; font-size: 0.9rem; margin: 0.5rem 0;">Window and door counts are estimates due to lack of clear images or manual input. Please upload photos or provide counts for better accuracy.</p>
      `;
    }

    resultsHtml += `
      <h3 style="color: #1a3c34; margin-bottom: 0.5rem; margin-top: 1.5rem; font-size: 1.3rem;">Material Breakdown</h3>
      <ul style="list-style-type: disc; padding-left: 1.5rem; margin-bottom: 1rem;">${materialEstimates.map(item => `<li>${item}</li>`).join("")}</ul>
      <h3 style="color: #1a3c34; margin-bottom: 0.5rem; margin-top: 1.5rem; font-size: 1.3rem;">Cost Estimate (Approximate)</h3>
    `;

    if (isCostReliable) {
      resultsHtml += `
        <p style="margin: 0.5rem 0;"><strong>Total:</strong> $${costEstimates.totalCost}</p>
        <ul style="list-style-type: disc; padding-left: 1.5rem; margin-bottom: 1rem;">${costEstimates.costBreakdown.map(item => `<li>${item}</li>`).join("")}</ul>
        <p style="font-style: italic; color: #666; font-size: 0.9rem; margin: 0.5rem 0;">Costs are approximate and may vary based on final measurements, material prices, and labor rates.</p>
      `;
      if (!isMeasurementsReliable || !isWindowDoorCountReliable) {
        resultsHtml += `
          <p style="color: #d32f2f; font-size: 0.9rem; margin: 0.5rem 0;">This estimate is based on partial data. For a more accurate estimate, upload clear photos or provide window/door counts.</p>
        `;
      }
    } else {
      resultsHtml += `
        <p style="color: #d32f2f; margin: 0.5rem 0;">Cost estimate unavailable because both building dimensions and window/door counts are unreliable. Please provide manual counts or upload clear photos of the house exterior.</p>
      `;
    }

    resultsHtml += `
      <h3 style="color: #1a3c34; margin-bottom: 0.5rem; margin-top: 1.5rem; font-size: 1.3rem;">Estimated Timeline</h3>
      <p style="margin: 0.5rem 0;">${timelineEstimate} weeks</p>
      <p style="font-style: italic; color: #666; font-size: 0.9rem; margin: 0.5rem 0;">Timeline depends on project scope, weather, and crew availability.</p>
      <h3 style="color: #1a3c34; margin-bottom: 0.5rem; margin-top: 1.5rem; font-size: 1.3rem;">Permit Information</h3>
      <p style="margin: 0.5rem 0;">Remodeling in Indiana may require permits for structural, electrical, or plumbing work. Contact your local building department.</p>
      <p style="margin: 0.5rem 0;"><a href="https://www.in.gov/dhs/building-construction/permits/" target="_blank" style="color: #e67e22; text-decoration: none;">Learn More About Indiana Permits</a></p>
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
      if (windowDoorCount.windows === 0 && windowDoorCount.doors === 0) {
        resultsHtml += `
          <p style="color: #d32f2f; font-size: 0.9rem; margin: 0.5rem 0;">Failed to detect windows or doors in uploaded image(s). Please upload clear photos of the house exterior.</p>
        `;
      } else {
        resultsHtml += `
          <p style="font-style: italic; color: #666; font-size: 0.9rem; margin: 0.5rem 0;">Processed ${Object.values(processedImages).length} user-uploaded image(s) for window and door detection. Up to 1 image per direction is processed.</p>
        `;
      }
    }

    if (satelliteImage) {
      resultsHtml += `
        <h3 style="color: #1a3c34; margin-bottom: 0.5rem; margin-top: 1.5rem; font-size: 1.3rem;">Satellite View (Google Maps)</h3>
        <div style="text-align: center;">
          <img src="${satelliteImage}" alt="Satellite View of House" style="max-width: 100%; border-radius: 8px; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1); margin: 1rem 0;">
        </div>
      `;
    } else if (satelliteImageError) {
      resultsHtml += `<p style="color: #d32f2f; text-align: center; margin: 1rem 0;">${satelliteImageError}</p>`;
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

    const smsSummary = `Remodel at ${addressDisplay}: ${measurements.area}sqft, ${windowDoorCount.windows} windows, ${windowDoorCount.doors} doors, ~$${costEstimates.totalCost || "N/A"}. Contact Indy Home Improvements for a detailed quote.`;
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
    console.error("Fetch error:", error);
    displayError(`Error: ${error.message}`);
  } finally {
    submitButton.disabled = false;
    submitButton.innerHTML = "Get Estimate";
  }
});

const directions = ["north", "south", "east", "west"];
directions.forEach(direction => {
  document.getElementById(`${direction}Photos`).addEventListener("change", (e) => {
    const preview = document.getElementById(`${direction}Preview`);
    preview.innerHTML = "";
    const files = Array.from(e.target.files);
    console.log(`Selected ${files.length} files for ${direction} direction:`, files.map(file => file.name));
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
});

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith("image/")) {
      reject(new Error("Invalid file type. Please upload images (JPEG, PNG)."));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      console.log(`Converted file ${file.name} to base64, length: ${reader.result.length}`);
      if (!reader.result || typeof reader.result !== "string") {
        reject(new Error(`Failed to convert ${file.name} to base64.`));
        return;
      }
      resolve(reader.result);
    };
    reader.onerror = () => {
      console.error(`Failed to read file ${file.name}`);
      reject(new Error(`Failed to read file ${file.name}.`));
    };
    reader.readAsDataURL(file);
  });
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
  console.log("Warning:", message);
  const resultsDiv = document.getElementById("results");
  if (resultsDiv.innerHTML === "") {
    resultsDiv.innerHTML = `
      <div style="background: white; border-radius: 8px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1); padding: 2rem; text-align: center;" role="alert">
        <p style="color: #e67e22; margin: 0.5rem 0;">${message}</p>
      </div>
    `;
  }
}