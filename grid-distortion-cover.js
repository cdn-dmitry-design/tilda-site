import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.181.1/build/three.module.js';

function getSettingsFromDataAttributes(element) {
  if (!(element instanceof HTMLElement) || !element.dataset) {
    console.error('Некорректный элемент: ожидается HTMLElement.');
    return {};
  }

  const settings = {};
  const data = element.dataset;

  for (const key in data) {
    if (Object.hasOwnProperty.call(data, key)) {
      let value = data[key];
      const parsedValue = parseFloat(value);
      if (!isNaN(parsedValue) && isFinite(parsedValue)) {
        if (value.indexOf('.') === -1 && parsedValue === Math.floor(parsedValue)) {
          settings[key] = parseInt(value, 10);
        } else {
          settings[key] = parsedValue;
        }
      } else {
        settings[key] = value;
      }
    }
  }

  return settings;
}

function getSafariTotalZoom(element) {
  let totalZoom = 1;
  let el = element;

  while (el && el !== document) {
    try {
      const style = window.getComputedStyle(el);
      const z = parseFloat(style.zoom) || 1;
      if (z !== 1) totalZoom *= z;
    } catch (e) {
      /* ignore */
    }
    el = el.parentElement;
  }
  return totalZoom;
}

const vertexShader = `
uniform float time;
varying vec2 vUv;
varying vec3 vPosition;
void main() {
  vUv = uv;
  vPosition = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** Как CSS object-fit: cover — центр кадра, обрезка по длинной стороне */
const fragmentShader = `
uniform sampler2D uDataTexture;
uniform sampler2D uTexture;
uniform vec4 resolution;
uniform float uImageAspect;
uniform float uContainerAspect;
varying vec2 vUv;

vec2 coverUV(vec2 uv) {
  float ia = max(uImageAspect, 0.0001);
  float ca = max(uContainerAspect, 0.0001);
  if (ia > ca) {
    float a = ca / ia;
    return vec2(uv.x * a + (1.0 - a) * 0.5, uv.y);
  } else {
    float a = ia / ca;
    return vec2(uv.x, uv.y * a + (1.0 - a) * 0.5);
  }
}

void main() {
  vec2 uv = coverUV(vUv);
  vec4 offset = texture2D(uDataTexture, vUv);
  gl_FragColor = texture2D(uTexture, uv - 0.02 * offset.rg);
}
`;

class GridDistortion {
  constructor(container, options = {}) {
    this.container = container;

    this.config = {
      grid: options.grid || 15,
      mouse: options.mouse || 0.1,
      strength: options.strength || 0.15,
      relaxation: options.relaxation || 0.9,
      imageSrc: options.imageSrc || 'https://mods.tistols.com/mods/grid-distortion/grid-distortion-background-example.jpg',
      className: options.className || '',
    };

    this.scene = null;
    this.renderer = null;
    this.camera = null;
    this.plane = null;
    this.material = null;
    this.geometry = null;
    this.dataTexture = null;
    this.uniforms = null;
    this.imageAspect = 1;
    this.containerAspect = 1;
    this.animationId = null;
    this.resizeObserver = null;

    this.mouseState = {
      x: 0,
      y: 0,
      prevX: 0,
      prevY: 0,
      vX: 0,
      vY: 0,
    };

    this.handleResize = this.handleResize.bind(this);
    this.handleMouseMove = this.handleMouseMove.bind(this);
    this.handleMouseLeave = this.handleMouseLeave.bind(this);
    this.animate = this.animate.bind(this);

    this.init();
  }

  init() {
    if (!this.container) return;

    this.scene = new THREE.Scene();
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.container.innerHTML = '';

    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.position = 'relative';

    this.container.appendChild(this.renderer.domElement);
    if (this.config.className) {
      this.container.classList.add(this.config.className);
    }

    this.camera = new THREE.OrthographicCamera(0, 0, 0, 0, -1000, 1000);
    this.camera.position.z = 2;

    this.uniforms = {
      time: { value: 0 },
      resolution: { value: new THREE.Vector4() },
      uTexture: { value: null },
      uDataTexture: { value: null },
      uImageAspect: { value: 1 },
      uContainerAspect: { value: 1 },
    };

    const textureLoader = new THREE.TextureLoader();
    if (this.config.imageSrc) {
      const applyTexture = (texture) => {
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;

        this.imageAspect = texture.image.width / texture.image.height;
        this.uniforms.uImageAspect.value = this.imageAspect;

        this.uniforms.uTexture.value = texture;

        this.handleResize();
      };

      const loadWithCors = (useCors) => {
        textureLoader.setCrossOrigin(useCors ? 'anonymous' : null);
        textureLoader.load(
          this.config.imageSrc,
          applyTexture,
          undefined,
          () => {
            if (useCors) {
              loadWithCors(false);
            } else {
              console.error('[grid-distortion-cover] Не удалось загрузить текстуру:', this.config.imageSrc);
            }
          }
        );
      };

      loadWithCors(true);
    }

    const size = this.config.grid;
    const data = new Float32Array(4 * size * size);
    for (let i = 0; i < size * size; i++) {
      data[i * 4] = Math.random() * 255 - 125;
      data[i * 4 + 1] = Math.random() * 255 - 125;
    }

    this.dataTexture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.FloatType);
    this.dataTexture.needsUpdate = true;
    this.uniforms.uDataTexture.value = this.dataTexture;

    this.material = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      uniforms: this.uniforms,
      vertexShader: vertexShader,
      fragmentShader: fragmentShader,
      transparent: true,
    });

    this.geometry = new THREE.PlaneGeometry(1, 1, size - 1, size - 1);
    this.plane = new THREE.Mesh(this.geometry, this.material);
    this.scene.add(this.plane);

    if (window.ResizeObserver) {
      this.resizeObserver = new ResizeObserver(this.handleResize);
      this.resizeObserver.observe(this.container);
    } else {
      window.addEventListener('resize', this.handleResize);
    }

    this.renderer.domElement.addEventListener('mousemove', this.handleMouseMove);
    this.renderer.domElement.addEventListener('mouseleave', this.handleMouseLeave);

    this.handleResize();
    requestAnimationFrame(() => this.handleResize());
    setTimeout(() => this.handleResize(), 50);
    setTimeout(() => this.handleResize(), 250);
    this.animate();
  }

  handleResize() {
    if (!this.container || !this.renderer || !this.camera) return;

    const rect = this.container.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;

    if (width === 0 || height === 0) return;

    this.containerAspect = width / height;
    this.uniforms.uContainerAspect.value = this.containerAspect;
    this.uniforms.uImageAspect.value = this.imageAspect;

    this.renderer.setSize(width, height);

    if (this.plane) {
      this.plane.scale.set(this.containerAspect, 1, 1);
    }

    const frustumHeight = 1;
    const frustumWidth = frustumHeight * this.containerAspect;

    this.camera.left = -frustumWidth / 2;
    this.camera.right = frustumWidth / 2;
    this.camera.top = frustumHeight / 2;
    this.camera.bottom = -frustumHeight / 2;
    this.camera.updateProjectionMatrix();

    this.uniforms.resolution.value.set(width, height, 1, 1);
  }

  handleMouseMove(e) {
    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    const canvas = this.renderer.domElement;

    let finalPixelX = 0;
    let finalPixelY = 0;

    if (isSafari) {
      const totalZoom = getSafariTotalZoom(this.container);

      let rawX = e.offsetX;
      let rawY = e.offsetY;

      if (typeof rawX !== 'number' || typeof rawY !== 'number') {
        const r = canvas.getBoundingClientRect();
        rawX = e.clientX - r.left;
        rawY = e.clientY - r.top;
      }

      const logicalX = rawX / totalZoom;
      const logicalY = rawY / totalZoom;

      const cssW = this.container.offsetWidth || 1;
      const cssH = this.container.offsetHeight || 1;

      const clampedX = Math.max(0, Math.min(cssW, logicalX));
      const clampedY = Math.max(0, Math.min(cssH, logicalY));

      finalPixelX = (clampedX / cssW) * canvas.width;
      finalPixelY = (clampedY / cssH) * canvas.height;
    } else {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      const cssX = e.clientX - rect.left;
      const cssY = e.clientY - rect.top;

      finalPixelX = cssX * (canvas.width / rect.width);
      finalPixelY = cssY * (canvas.height / rect.height);
    }

    const normalizedX = finalPixelX / canvas.width;
    const normalizedY = finalPixelY / canvas.height;

    const x = Math.max(0, Math.min(1, normalizedX));
    const y = Math.max(0, Math.min(1, 1 - normalizedY));

    this.mouseState.vX = x - this.mouseState.prevX;
    this.mouseState.vY = y - this.mouseState.prevY;

    Object.assign(this.mouseState, {
      x,
      y,
      prevX: x,
      prevY: y,
    });
  }

  handleMouseLeave() {
    if (this.dataTexture) {
      this.dataTexture.needsUpdate = true;
    }
    Object.assign(this.mouseState, {
      x: 0,
      y: 0,
      prevX: 0,
      prevY: 0,
      vX: 0,
      vY: 0,
    });
  }

  animate() {
    this.animationId = requestAnimationFrame(this.animate);
    if (!this.dataTexture) return;

    this.uniforms.time.value += 0.05;

    const size = this.config.grid;
    const data = this.dataTexture.image.data;

    for (let i = 0; i < size * size; i++) {
      data[i * 4] *= this.config.relaxation;
      data[i * 4 + 1] *= this.config.relaxation;
    }

    const gridMouseX = size * this.mouseState.x;
    const gridMouseY = size * this.mouseState.y;
    const maxDist = size * this.config.mouse;
    const force = this.config.strength * 100;

    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) {
        const distSq = Math.pow(gridMouseX - i, 2) + Math.pow(gridMouseY - j, 2);

        if (distSq < maxDist * maxDist) {
          const index = 4 * (i + size * j);

          let power = maxDist / Math.sqrt(distSq);
          if (power > 10) power = 10;

          data[index] += force * this.mouseState.vX * power;
          data[index + 1] -= force * this.mouseState.vY * power;
        }
      }
    }

    this.dataTexture.needsUpdate = true;
    this.renderer.render(this.scene, this.camera);
  }

  destroy() {
    if (this.animationId) cancelAnimationFrame(this.animationId);
    if (this.resizeObserver) this.resizeObserver.disconnect();
    else window.removeEventListener('resize', this.handleResize);

    this.container.removeEventListener('mousemove', this.handleMouseMove);
    this.container.removeEventListener('mouseleave', this.handleMouseLeave);

    if (this.renderer) {
      this.renderer.dispose();
      if (this.container.contains(this.renderer.domElement)) {
        this.container.removeChild(this.renderer.domElement);
      }
    }

    if (this.geometry) this.geometry.dispose();
    if (this.material) this.material.dispose();
    if (this.dataTexture) this.dataTexture.dispose();
    if (this.uniforms && this.uniforms.uTexture.value) this.uniforms.uTexture.value.dispose();
  }
}

const distortionInitialized = new WeakSet();

/**
 * В Тильде цепочка height:100% часто даёт 0px: у absolute-обёртки нет опорной высоты.
 * Даём предкам min-height, иначе canvas WebGL получает размер 0×0.
 */
function ensureAncestorsMinHeight(container, minVh = 60) {
  const fallbackPx = Math.round(Math.max((window.innerHeight * minVh) / 100, 280));
  const minCombined = `max(${minVh}vh, ${fallbackPx}px)`;
  let el = container;
  for (let depth = 0; depth < 10 && el; depth++) {
    const h = el.offsetHeight || el.getBoundingClientRect().height;
    if (h < 8) {
      el.style.minHeight = minCombined;
    }
    el = el.parentElement;
  }
}

function initGridDistortionContainers() {
  document.querySelectorAll('.distortion-container').forEach((container) => {
    if (distortionInitialized.has(container)) return;

    const settings = getSettingsFromDataAttributes(container);

    const parentDiv = container.parentElement;
    if (parentDiv) {
      parentDiv.style.position = 'absolute';
      parentDiv.style.top = '0';
      parentDiv.style.bottom = '0';
      parentDiv.style.left = '0';
      parentDiv.style.right = '0';
      parentDiv.style.height = '100%';
      parentDiv.style.minHeight = '100%';
    }

    const minVh = parseFloat(container.dataset.minHeightVh || '60') || 60;
    ensureAncestorsMinHeight(container, minVh);

    const zeroBlock = parentDiv?.parentElement?.parentElement;
    const distortionImg = zeroBlock?.querySelector('.distortion-img img');
    if (distortionImg) {
      settings.imageSrc = distortionImg.src;
      distortionImg.style.display = 'none';
    }

    distortionInitialized.add(container);

    new GridDistortion(container, settings);
  });
}

let distortionMoTimer = null;
function scheduleGridDistortionInit() {
  initGridDistortionContainers();
  requestAnimationFrame(() => initGridDistortionContainers());
  setTimeout(initGridDistortionContainers, 0);
  setTimeout(initGridDistortionContainers, 100);
  setTimeout(initGridDistortionContainers, 500);
  setTimeout(initGridDistortionContainers, 1500);
}

function setupDistortionMutationObserver() {
  if (!document.body || !window.MutationObserver) return;
  const mo = new MutationObserver(() => {
    clearTimeout(distortionMoTimer);
    distortionMoTimer = setTimeout(scheduleGridDistortionInit, 80);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    scheduleGridDistortionInit();
    setupDistortionMutationObserver();
  });
} else {
  scheduleGridDistortionInit();
  setupDistortionMutationObserver();
}

window.addEventListener('load', scheduleGridDistortionInit);

window.initGridDistortionCover = scheduleGridDistortionInit;
