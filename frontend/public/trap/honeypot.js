(function () {
  "use strict";

  var timeEl = document.getElementById("visitor-time");
  var ipEl = document.getElementById("visitor-ip");
  var locEl = document.getElementById("visitor-location");
  var mapWrap = document.getElementById("map-wrap");

  var now = new Date();
  try {
    timeEl.textContent = now.toLocaleString("th-TH", {
      timeZone: "Asia/Bangkok",
      dateStyle: "long",
      timeStyle: "medium",
    });
  } catch (e) {
    timeEl.textContent = now.toISOString();
  }

  function showMapUnavailable() {
    mapWrap.innerHTML = '<span class="map-placeholder">ไม่สามารถแสดงแผนที่ได้ในขณะนี้</span>';
  }

  function renderMap(lat, lon) {
    var delta = 0.2;
    var bbox = [lon - delta, lat - delta, lon + delta, lat + delta].join(",");
    var iframe = document.createElement("iframe");
    iframe.loading = "lazy";
    iframe.title = "แผนที่ตำแหน่งโดยประมาณของผู้เข้าถึง";
    iframe.src =
      "https://www.openstreetmap.org/export/embed.html?bbox=" +
      encodeURIComponent(bbox) +
      "&layer=mapnik&marker=" +
      encodeURIComponent(lat + "," + lon);
    mapWrap.innerHTML = "";
    mapWrap.appendChild(iframe);
  }

  fetch("https://ipapi.co/json/", { headers: { Accept: "application/json" } })
    .then(function (res) {
      if (!res.ok) throw new Error("geo lookup failed");
      return res.json();
    })
    .then(function (data) {
      if (!data || data.error) throw new Error((data && data.reason) || "geo lookup error");

      ipEl.textContent = data.ip || "ไม่สามารถระบุได้";

      var parts = [data.city, data.region, data.country_name].filter(Boolean);
      locEl.textContent = parts.length ? parts.join(", ") : "ไม่สามารถระบุได้";

      if (typeof data.latitude === "number" && typeof data.longitude === "number") {
        renderMap(data.latitude, data.longitude);
      } else {
        showMapUnavailable();
      }
    })
    .catch(function () {
      ipEl.textContent = "ไม่สามารถระบุได้ (ระบบยังคงบันทึกการเข้าถึงนี้ไว้)";
      locEl.textContent = "ไม่สามารถระบุได้";
      showMapUnavailable();
    });
})();
