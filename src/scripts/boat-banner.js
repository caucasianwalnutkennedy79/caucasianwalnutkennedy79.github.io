// Interactive USV boat banner.
//
// Ported verbatim from prototypes/boat-banner.html (the frozen reference); only
// the wrapper changed: the function is exported instead of being a page global,
// and the page-level auto-init call moved to src/components/BoatBanner.astro.
// Behaviour is pinned by tests/banner/ (run: npm run test:banner) — do not
// "improve" the dynamics/guidance here without updating those tests deliberately.

export function initBoatBanner(canvas, options = {}) {
  const ctx = canvas.getContext('2d');
  const banner = canvas.closest('.banner');
  const hint = banner.querySelector('.banner-hint');
  const telemetry = banner.querySelector('.banner-telemetry');
  const clearButton = banner.querySelector('.banner-clear');
  const shipSelect = banner.querySelector('.banner-ship-select');
  const reduceQuery = matchMedia('(prefers-reduced-motion: reduce)');
  const schemeQuery = matchMedia('(prefers-color-scheme: dark)');
  const { testMode = false, ship: requestedShip, ...tuning } = options;
  const shipIds = new Set(['motorboat', 'pirate', 'catamaran']);
  const shipStorageKey = 'portfolio.boatBanner.ship';

  // All motion tuning lives here. Distances are CSS pixels; time is seconds.
  const config = Object.assign({
    cruiseSpeed: 112,
    maxAcceleration: 54,
    maxDeceleration: 82,
    maxTurnRate: 3.0,
    minTurnScale: 0.16,
    minimumSteerageSpeed: 2,
    headingGain: 2.5,
    lookahead: 54,
    acceptanceRadius: 9,
    hullLength: 46,
    waypointLimit: 8,
    maxRings: 200,
    wakeLife: 2.0
  }, tuning);
  config.waypointLimit = Math.max(2, Math.floor(Number(config.waypointLimit) || 2));

  function initialShip() {
    try {
      const storedShip = localStorage.getItem(shipStorageKey);
      if (shipIds.has(storedShip)) return storedShip;
    } catch {
      // Storage can be unavailable for file:// pages or privacy settings.
    }
    return shipIds.has(requestedShip) ? requestedShip : 'motorboat';
  }

  const state = {
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    psi: 0,
    u: 0,
    queue: [],
    rings: [],
    wakeDistance: 0,
    running: false,
    inView: true,
    destroyed: false,
    lastTime: 0,
    rafId: 0,
    ship: initialShip(),
    reducedMotion: reduceQuery.matches
  };

  let palette = {};
  let pointerGesture = null;
  let resolutionQuery = null;
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const wrapToPi = angle => Math.atan2(Math.sin(angle), Math.cos(angle));
  const moveToward = (value, target, amount) =>
    value < target ? Math.min(value + amount, target) : Math.max(value - amount, target);
  const turnLimitForSpeed = speed => config.maxTurnRate *
    (config.minTurnScale + (1 - config.minTurnScale) *
      clamp(speed / config.cruiseSpeed, 0, 1));

  function maxSpeedForTurnRadius(radius) {
    const baseTurnRate = config.maxTurnRate * config.minTurnScale;
    const turnRateSlope = config.maxTurnRate * (1 - config.minTurnScale) /
      config.cruiseSpeed;
    const denominator = 1 - radius * turnRateSlope;
    return denominator <= 0
      ? config.cruiseSpeed
      : clamp(radius * baseTurnRate / denominator, 0, config.cruiseSpeed);
  }

  function readPalette() {
    const css = getComputedStyle(document.documentElement);
    const get = name => css.getPropertyValue(name).trim();
    palette = {
      waterTop: get('--water-top'), waterBottom: get('--water-bottom'),
      waterLine: get('--water-line'), route: get('--route'),
      wake: get('--wake'), ripple: get('--ripple'),
      hull: get('--hull'), hullEdge: get('--hull-edge'), deck: get('--deck'),
      windscreen: get('--windscreen'), wood: get('--wood'),
      woodEdge: get('--wood-edge'), sail: get('--sail'),
      sailEdge: get('--sail-edge'), mast: get('--mast'),
      pennant: get('--pennant'), pennantEdge: get('--pennant-edge'),
      trampoline: get('--trampoline'), trampolineLine: get('--trampoline-line')
    };
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const width = rect.width;
    const height = rect.height;
    const scaleX = state.width ? width / state.width : 1;
    const scaleY = state.height ? height / state.height : 1;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);

    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (!state.width) {
      state.x = width * 0.2;
      state.y = height * 0.52;
    } else {
      state.x *= scaleX;
      state.y *= scaleY;
      for (const point of state.queue) {
        point.x *= scaleX;
        point.y *= scaleY;
        point.startX *= scaleX;
        point.startY *= scaleY;
        clampWaypoint(point, width, height);
      }
      for (const ring of state.rings) {
        ring.x *= scaleX;
        ring.y *= scaleY;
      }
    }

    state.width = width;
    state.height = height;
    keepBoatInBounds();
    draw();
  }

  function keepBoatInBounds() {
    const margin = config.hullLength * 0.57;
    state.x = clamp(state.x, margin, Math.max(margin, state.width - margin));
    state.y = clamp(state.y, margin, Math.max(margin, state.height - margin));
  }

  function clampWaypoint(point, width = state.width, height = state.height) {
    const margin = config.hullLength * 0.6;
    point.x = clamp(point.x, margin, Math.max(margin, width - margin));
    point.y = clamp(point.y, margin, Math.max(margin, height - margin));
    point.startX = clamp(point.startX, margin, Math.max(margin, width - margin));
    point.startY = clamp(point.startY, margin, Math.max(margin, height - margin));
    return point;
  }

  function routeStart() {
    const tail = state.queue[state.queue.length - 1];
    return tail ? { x: tail.x, y: tail.y } : { x: state.x, y: state.y };
  }

  function enqueueWaypoint(x, y) {
    const start = routeStart();
    const waypoint = clampWaypoint({
      x,
      y,
      startX: start.x,
      startY: start.y
    });

    if (state.queue.length >= config.waypointLimit) state.queue.splice(1, 1);
    state.queue.push(waypoint);
    hint.classList.add('dismissed');
    spawnClickRipple(waypoint.x, waypoint.y);
    startLoop();
  }

  function clearRoute() {
    state.queue.length = 0;
    startLoop();
  }

  function spawnClickRipple(x, y) {
    if (state.reducedMotion) return;
    addRing({ x, y, age: 0, life: 1.25, size: 5, opacity: 0.62, kind: 'click' });
    addRing({ x, y, age: -0.16, life: 1.45, size: 5, opacity: 0.42, kind: 'click' });
  }

  function spawnWake() {
    if (state.reducedMotion || state.u < 8) return;
    const speedRatio = clamp(state.u / config.cruiseSpeed, 0, 1);
    const normalX = -Math.sin(state.psi);
    const normalY = Math.cos(state.psi);

    for (const source of shipStyles[state.ship].wakeSources) {
      const sternX = state.x - Math.cos(state.psi) * config.hullLength * source.aft;
      const sternY = state.y - Math.sin(state.psi) * config.hullLength * source.aft;
      addRing({
        x: sternX + normalX * config.hullLength * source.side,
        y: sternY + normalY * config.hullLength * source.side,
        age: 0,
        life: config.wakeLife,
        size: config.hullLength * 0.088,
        opacity: 0.16 + 0.32 * speedRatio,
        kind: 'wake'
      });
    }
  }

  function addRing(ring) {
    state.rings.push(ring);
    if (state.rings.length > config.maxRings) {
      state.rings.splice(0, state.rings.length - config.maxRings);
    }
  }

  function updateBoat(dt) {
    const target = state.queue[0];
    let desiredSpeed = 0;
    let turnRate = 0;

    if (target) {
      const toTargetX = target.x - state.x;
      const toTargetY = target.y - state.y;
      const distance = Math.hypot(toTargetX, toTargetY);

      const isFinalWaypoint = state.queue.length === 1;
      if (distance <= config.acceptanceRadius && (!isFinalWaypoint || state.u <= 16)) {
        state.queue.shift();
        if (isFinalWaypoint) state.u = 0;
        if (state.queue[0]) {
          state.queue[0].startX = state.x;
          state.queue[0].startY = state.y;
        }
        return;
      }

      const segmentX = target.x - target.startX;
      const segmentY = target.y - target.startY;
      const segmentLength = Math.hypot(segmentX, segmentY);
      let aimX = target.x;
      let aimY = target.y;

      if (segmentLength > 0.001) {
        const tangentX = segmentX / segmentLength;
        const tangentY = segmentY / segmentLength;
        const projection = (state.x - target.startX) * tangentX +
          (state.y - target.startY) * tangentY;
        const aimDistance = clamp(projection + config.lookahead, 0, segmentLength);
        aimX = target.startX + tangentX * aimDistance;
        aimY = target.startY + tangentY * aimDistance;
      }

      if (Math.hypot(aimX - state.x, aimY - state.y) < 1) {
        aimX = target.x;
        aimY = target.y;
      }

      const desiredHeading = Math.atan2(aimY - state.y, aimX - state.x);
      const headingError = wrapToPi(desiredHeading - state.psi);
      const turnLimit = turnLimitForSpeed(state.u);
      turnRate = clamp(config.headingGain * headingError, -turnLimit, turnLimit);

      const headingScale = 0.12 + 0.88 * Math.pow(Math.max(0, Math.cos(headingError)), 2);
      desiredSpeed = config.cruiseSpeed * headingScale;
      if (isFinalWaypoint) {
        const stoppingSpeed = Math.sqrt(2 * config.maxDeceleration * Math.max(0, distance - 3));
        desiredSpeed = Math.min(desiredSpeed, stoppingSpeed);
      }

      // A constant-radius turn reaches a target at bearing e only when
      // radius <= distance / (2 sin|e|). For targets aft, use the 90-degree
      // demand so they cannot evade the cap as sin(e) falls toward zero.
      const turnDemand = Math.sin(Math.min(Math.abs(headingError), Math.PI / 2));
      if (turnDemand > 0.001) {
        const reachableRadius = distance / (2 * turnDemand);
        const reachableSpeed = maxSpeedForTurnRadius(reachableRadius);
        desiredSpeed = Math.min(desiredSpeed,
          Math.max(config.minimumSteerageSpeed, reachableSpeed));
      }
    }

    const rate = desiredSpeed > state.u ? config.maxAcceleration : config.maxDeceleration;
    state.u = moveToward(state.u, desiredSpeed, rate * dt);
    state.psi = wrapToPi(state.psi + turnRate * dt);

    const oldX = state.x;
    const oldY = state.y;
    state.x += Math.cos(state.psi) * state.u * dt;
    state.y += Math.sin(state.psi) * state.u * dt;
    keepBoatInBounds();

    const travelled = Math.hypot(state.x - oldX, state.y - oldY);
    if (!state.reducedMotion && state.u > 8) {
      state.wakeDistance += travelled;
      const speedRatio = clamp(state.u / config.cruiseSpeed, 0, 1);
      const spacing = 19 - 8 * speedRatio;
      while (state.wakeDistance >= spacing) {
        state.wakeDistance -= spacing;
        spawnWake();
      }
    } else {
      state.wakeDistance = 0;
    }
  }

  function updateRings(dt) {
    for (const ring of state.rings) ring.age += dt;
    state.rings = state.rings.filter(ring => ring.age < ring.life);
  }

  function drawWater(time = performance.now() * 0.001) {
    const gradient = ctx.createLinearGradient(0, 0, 0, state.height);
    gradient.addColorStop(0, palette.waterTop);
    gradient.addColorStop(1, palette.waterBottom);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, state.width, state.height);

    ctx.strokeStyle = palette.waterLine;
    ctx.lineWidth = 1;
    for (let row = 0; row < 5; row++) {
      const baseY = (row + 1) * state.height / 6;
      ctx.beginPath();
      for (let x = -20; x <= state.width + 20; x += 20) {
        const y = baseY + Math.sin(x * 0.018 + row * 1.7 + time * 0.18) * 2.3;
        if (x === -20) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }

  function drawRoute() {
    if (!state.queue.length) return;
    ctx.save();
    ctx.strokeStyle = palette.route;
    ctx.fillStyle = palette.route;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([5, 7]);
    ctx.beginPath();
    ctx.moveTo(state.x, state.y);
    for (const point of state.queue) ctx.lineTo(point.x, point.y);
    ctx.stroke();
    ctx.setLineDash([]);

    state.queue.forEach((point, index) => {
      ctx.beginPath();
      ctx.arc(point.x, point.y, index ? 3.5 : 5, 0, Math.PI * 2);
      ctx.stroke();
      if (!index) {
        ctx.beginPath();
        ctx.arc(point.x, point.y, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
    });
    ctx.restore();
  }

  function drawRings() {
    ctx.save();
    for (const ring of state.rings) {
      if (ring.age < 0) continue;
      const progress = clamp(ring.age / ring.life, 0, 1);
      const radius = ring.kind === 'click' ? ring.size + progress * 34 : ring.size + progress * 18;
      ctx.globalAlpha = ring.opacity * Math.pow(1 - progress, 1.6);
      ctx.strokeStyle = ring.kind === 'click' ? palette.ripple : palette.wake;
      ctx.lineWidth = ring.kind === 'click' ? 1.4 : 1;
      ctx.beginPath();
      ctx.ellipse(ring.x, ring.y, radius * 1.35, radius * 0.7, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  function roundedRectPath(x, y, width, height, radius) {
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, width, height, radius);
    } else {
      ctx.rect(x, y, width, height);
    }
  }

  function drawMotorboat(length) {
    const scale = length / 34;
    const halfWidth = length * 0.22;
    ctx.fillStyle = palette.hull;
    ctx.strokeStyle = palette.hullEdge;
    ctx.lineWidth = 1.2 * scale;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(length * 0.55, 0);
    ctx.lineTo(length * 0.18, -halfWidth);
    ctx.lineTo(-length * 0.45, -halfWidth * 0.8);
    ctx.lineTo(-length * 0.45, halfWidth * 0.8);
    ctx.lineTo(length * 0.18, halfWidth);
    ctx.closePath();
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.stroke();

    ctx.fillStyle = palette.deck;
    ctx.beginPath();
    const deckX = -length * 0.16;
    const deckY = -halfWidth * 0.48;
    const deckWidth = length * 0.31;
    const deckHeight = halfWidth * 0.96;
    roundedRectPath(deckX, deckY, deckWidth, deckHeight, length * 0.059);
    ctx.fill();

    ctx.fillStyle = palette.windscreen;
    ctx.beginPath();
    ctx.moveTo(length * 0.08, -halfWidth * 0.42);
    ctx.lineTo(length * 0.16, -halfWidth * 0.29);
    ctx.lineTo(length * 0.16, halfWidth * 0.29);
    ctx.lineTo(length * 0.08, halfWidth * 0.42);
    ctx.closePath();
    ctx.fill();
  }

  function drawPirateShip(length, time) {
    const scale = length / 34;
    const halfWidth = length * 0.23;
    ctx.fillStyle = palette.wood;
    ctx.strokeStyle = palette.woodEdge;
    ctx.lineWidth = 1.2 * scale;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(length * 0.52, 0);
    ctx.quadraticCurveTo(length * 0.2, -halfWidth, -length * 0.45, -halfWidth * 0.78);
    ctx.lineTo(-length * 0.45, halfWidth * 0.78);
    ctx.quadraticCurveTo(length * 0.2, halfWidth, length * 0.52, 0);
    ctx.closePath();
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.stroke();

    ctx.strokeStyle = palette.woodEdge;
    ctx.globalAlpha = 0.42;
    ctx.beginPath();
    ctx.moveTo(-length * 0.35, 0);
    ctx.lineTo(length * 0.36, 0);
    ctx.stroke();
    ctx.globalAlpha = 1;

    const masts = [
      { x: -length * 0.2, span: halfWidth * 0.67, main: false },
      { x: length * 0.02, span: halfWidth * 0.88, main: true },
      { x: length * 0.25, span: halfWidth * 0.56, main: false }
    ];
    ctx.fillStyle = palette.sail;
    ctx.strokeStyle = palette.sailEdge;
    ctx.lineWidth = length * 0.018;
    ctx.lineJoin = 'round';
    for (const mast of masts) {
      const belly = length * (mast.main ? 0.14 : 0.115);
      ctx.beginPath();
      ctx.moveTo(mast.x, -mast.span);
      ctx.quadraticCurveTo(mast.x + belly, 0, mast.x, mast.span);
      ctx.quadraticCurveTo(mast.x - belly * 0.38, 0, mast.x, -mast.span);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    ctx.fillStyle = palette.mast;
    for (const mast of masts) {
      ctx.beginPath();
      ctx.arc(mast.x, 0, length * (mast.main ? 0.049 : 0.038), 0, Math.PI * 2);
      ctx.fill();
    }

    const pennant = piratePennantGeometry(length, state.u, time, state.reducedMotion);
    ctx.fillStyle = palette.pennant;
    ctx.strokeStyle = palette.pennantEdge;
    ctx.lineWidth = length * 0.018;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(pennant.hoistX, -pennant.hoistHalfWidth);
    ctx.lineTo(pennant.tipX, pennant.tipY - pennant.tailHalfWidth);
    ctx.lineTo(pennant.notchX, pennant.tipY);
    ctx.lineTo(pennant.tipX, pennant.tipY + pennant.tailHalfWidth);
    ctx.lineTo(pennant.hoistX, pennant.hoistHalfWidth);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  function piratePennantGeometry(length, speed, time, reducedMotion) {
    const mainMastX = length * 0.02;
    const speedRatio = clamp(speed / config.cruiseSpeed, 0, 1);
    const flagLength = length * 0.16;
    const flutter = reducedMotion ? 0 : Math.sin(time * 7 + state.x * 0.025) *
      length * speedRatio * 0.047;
    const droop = length * 0.04 * (1 - speedRatio);
    return {
      flagLength,
      hoistX: mainMastX - length * 0.012,
      tipX: mainMastX - flagLength,
      notchX: mainMastX - flagLength * 0.73,
      tipY: droop + flutter,
      hoistHalfWidth: length * 0.04,
      tailHalfWidth: length * (0.018 + speedRatio * 0.015)
    };
  }

  function drawCatamaran(length) {
    const scale = length / 34;
    const hullOffset = length * 0.17;
    const hullHalfWidth = length * 0.065;

    // Cast one combined hull shadow, then draw every detail without blur.
    ctx.fillStyle = palette.hull;
    ctx.beginPath();
    for (const side of [-1, 1]) {
      catamaranHullPath(length, side * hullOffset, hullHalfWidth);
    }
    ctx.fill();
    ctx.shadowColor = 'transparent';

    ctx.fillStyle = palette.trampoline;
    ctx.strokeStyle = palette.trampolineLine;
    ctx.lineWidth = 0.8 * scale;
    ctx.beginPath();
    ctx.rect(-length * 0.23, -hullOffset, length * 0.48, hullOffset * 2);
    ctx.fill();
    ctx.stroke();

    ctx.strokeStyle = palette.trampolineLine;
    ctx.lineWidth = 0.7 * scale;
    for (let x = -length * 0.2; x <= length * 0.14; x += length * 0.11) {
      ctx.beginPath();
      ctx.moveTo(x, -hullOffset);
      ctx.lineTo(x + length * 0.1, hullOffset);
      ctx.moveTo(x + length * 0.1, -hullOffset);
      ctx.lineTo(x, hullOffset);
      ctx.stroke();
    }

    ctx.fillStyle = palette.hull;
    ctx.strokeStyle = palette.hullEdge;
    ctx.lineWidth = 1.1 * scale;
    ctx.lineJoin = 'round';
    for (const side of [-1, 1]) {
      const centerY = side * hullOffset;
      ctx.beginPath();
      catamaranHullPath(length, centerY, hullHalfWidth);
      ctx.fill();
      ctx.stroke();
    }
  }

  function catamaranHullPath(length, centerY, halfWidth) {
    ctx.moveTo(length * 0.5, centerY);
    ctx.lineTo(length * 0.2, centerY - halfWidth);
    ctx.lineTo(-length * 0.45, centerY - halfWidth * 0.82);
    ctx.lineTo(-length * 0.45, centerY + halfWidth * 0.82);
    ctx.lineTo(length * 0.2, centerY + halfWidth);
    ctx.closePath();
  }

  const shipStyles = {
    motorboat: {
      draw: drawMotorboat,
      wakeSources: [{ aft: 0.46, side: -0.162 }, { aft: 0.46, side: 0.162 }]
    },
    pirate: {
      draw: drawPirateShip,
      wakeSources: [{ aft: 0.46, side: -0.162 }, { aft: 0.46, side: 0.162 }]
    },
    catamaran: {
      draw: drawCatamaran,
      wakeSources: [{ aft: 0.45, side: -0.17 }, { aft: 0.45, side: 0.17 }]
    }
  };

  function drawBoat(time) {
    const scale = config.hullLength / 34;
    ctx.save();
    ctx.translate(state.x, state.y);
    ctx.rotate(state.psi);
    ctx.shadowColor = 'rgba(0, 25, 34, .22)';
    ctx.shadowBlur = 7 * scale;
    ctx.shadowOffsetY = 3 * scale;
    shipStyles[state.ship].draw(config.hullLength, time);
    ctx.restore();
  }

  function draw(time = performance.now() * 0.001) {
    if (!state.width || !state.height) return;
    drawWater(time);
    drawRoute();
    drawRings();
    drawBoat(time);
    const degrees = ((Math.round(state.psi * 180 / Math.PI) % 360) + 360) % 360;
    telemetry.value = `HDG ${String(degrees).padStart(3, '0')}° · ${Math.round(state.u)} px/s`;
  }

  function isActive() {
    return state.queue.length > 0 || state.rings.length > 0 || state.u > 0.05;
  }

  function frame(time) {
    if (!state.running) return;
    const dt = state.lastTime ? Math.min((time - state.lastTime) / 1000, 0.05) : 0;
    state.lastTime = time;
    updateBoat(dt);
    updateRings(dt);
    if (!testMode) draw(time * 0.001);

    if (isActive() && state.inView && !document.hidden) {
      state.rafId = requestAnimationFrame(frame);
    } else {
      state.running = false;
      state.lastTime = 0;
    }
  }

  function startLoop() {
    if (state.destroyed || state.running || !state.inView || document.hidden) return;
    state.running = true;
    state.lastTime = 0;
    state.rafId = requestAnimationFrame(frame);
  }

  function stopLoop() {
    cancelAnimationFrame(state.rafId);
    state.running = false;
    state.lastTime = 0;
  }

  function applyShip(id, persist) {
    if (!shipIds.has(id)) return state.ship;
    state.ship = id;
    shipSelect.value = state.ship;
    if (persist) {
      try {
        localStorage.setItem(shipStorageKey, state.ship);
      } catch {
        // Storage can be unavailable for file:// pages or privacy settings.
      }
    }
    draw();
    return state.ship;
  }

  function setShip(id) {
    return applyShip(id, true);
  }

  function onShipChange() {
    applyShip(shipSelect.value, true);
  }

  function onPointerDown(event) {
    if (event.button !== 0 || pointerGesture) return;
    pointerGesture = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startedAt: event.timeStamp,
      maxDistance: 0,
      shiftKey: event.shiftKey
    };
    canvas.setPointerCapture?.(event.pointerId);
  }

  function onPointerMove(event) {
    if (!pointerGesture || event.pointerId !== pointerGesture.id) return;
    pointerGesture.maxDistance = Math.max(pointerGesture.maxDistance,
      Math.hypot(event.clientX - pointerGesture.x, event.clientY - pointerGesture.y));
  }

  function releasePointer(event) {
    if (!pointerGesture || event.pointerId !== pointerGesture.id) return null;
    const gesture = pointerGesture;
    pointerGesture = null;
    if (canvas.hasPointerCapture?.(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
    return gesture;
  }

  function onPointerUp(event) {
    const gesture = releasePointer(event);
    if (!gesture) return;
    const distance = Math.max(gesture.maxDistance,
      Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y));
    if (distance >= 10 || event.timeStamp - gesture.startedAt >= 400) return;
    event.preventDefault();
    if (gesture.shiftKey || event.shiftKey) {
      clearRoute();
      return;
    }
    const rect = canvas.getBoundingClientRect();
    enqueueWaypoint(event.clientX - rect.left, event.clientY - rect.top);
  }

  function onPointerCancel(event) {
    releasePointer(event);
  }

  function onKey(event) {
    if (event.repeat || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    const margin = config.hullLength;
    enqueueWaypoint(
      margin + Math.random() * Math.max(1, state.width - margin * 2),
      margin + Math.random() * Math.max(1, state.height - margin * 2)
    );
  }

  function onVisibility() {
    if (document.hidden) stopLoop();
    else if (isActive()) startLoop();
  }

  function onMotionChange(event) {
    state.reducedMotion = event.matches;
    if (state.reducedMotion) state.rings.length = 0;
    draw();
    if (isActive()) startLoop();
  }

  function onSchemeChange() {
    readPalette();
    draw();
  }

  function onResolutionChange() {
    resize();
    armResolutionQuery();
  }

  function armResolutionQuery() {
    resolutionQuery?.removeEventListener('change', onResolutionChange);
    resolutionQuery = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    resolutionQuery.addEventListener('change', onResolutionChange, { once: true });
  }

  const resizeObserver = new ResizeObserver(resize);
  const intersectionObserver = new IntersectionObserver(([entry]) => {
    state.inView = entry.isIntersecting;
    if (state.inView && isActive()) startLoop(); else if (!state.inView) stopLoop();
  }, { threshold: 0.01 });

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('keydown', onKey);
  shipSelect.addEventListener('change', onShipChange);
  clearButton.addEventListener('click', clearRoute);
  document.addEventListener('visibilitychange', onVisibility);
  reduceQuery.addEventListener('change', onMotionChange);
  schemeQuery.addEventListener('change', onSchemeChange);
  armResolutionQuery();
  resizeObserver.observe(canvas);
  intersectionObserver.observe(banner);
  readPalette();
  shipSelect.value = state.ship;
  resize();

  const api = {
    clear: clearRoute,
    setShip,
    destroy() {
      state.destroyed = true;
      stopLoop();
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      resolutionQuery?.removeEventListener('change', onResolutionChange);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('keydown', onKey);
      shipSelect.removeEventListener('change', onShipChange);
      clearButton.removeEventListener('click', clearRoute);
      document.removeEventListener('visibilitychange', onVisibility);
      reduceQuery.removeEventListener('change', onMotionChange);
      schemeQuery.removeEventListener('change', onSchemeChange);
    }
  };

  if (testMode) {
    api.test = {
      reset({
        x = state.width / 2,
        y = state.height / 2,
        psi = 0,
        u = 0,
        reducedMotion = true
      } = {}) {
        stopLoop();
        state.x = x;
        state.y = y;
        state.psi = psi;
        state.u = u;
        state.queue.length = 0;
        state.rings.length = 0;
        state.wakeDistance = 0;
        state.reducedMotion = reducedMotion;
        state.inView = true;
        keepBoatInBounds();
      },
      enqueue: enqueueWaypoint,
      resize,
      draw,
      pennantGeometry: (speed, time = 0, reducedMotion = false) =>
        piratePennantGeometry(config.hullLength, speed, time, reducedMotion),
      snapshot: () => ({
        x: state.x,
        y: state.y,
        psi: state.psi,
        u: state.u,
        ship: state.ship,
        ringCount: state.rings.length,
        queueLength: state.queue.length,
        running: state.running,
        active: isActive()
      })
    };
  }

  return api;
}
