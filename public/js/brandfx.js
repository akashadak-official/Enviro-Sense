// The corner position and scale must match .brand.corner in style.css
const CORNER = { top: 14, left: 22, scale: 0.5 };

// Pins the title block where it is, then glides it to the top-left corner
function flyBrandToCorner(brand, ms = 900) {
  return new Promise(resolve => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return resolve();

    const r = brand.getBoundingClientRect();
    const pt = parseFloat(getComputedStyle(brand).paddingTop) || 0;
    const top0 = r.top + pt, left0 = r.left;

    brand.style.transition = 'none';
    brand.style.position = 'fixed';
    brand.style.margin = '0';
    brand.style.paddingTop = '0';
    brand.style.top = top0 + 'px';
    brand.style.left = left0 + 'px';
    brand.style.transformOrigin = 'top left';
    brand.style.zIndex = '50';
    void brand.offsetWidth;                       // apply the pinned position first

    brand.style.transition = `transform ${ms}ms cubic-bezier(0.22, 1, 0.36, 1)`;
    requestAnimationFrame(() => {
      brand.style.transform =
        `translate(${CORNER.left - left0}px, ${CORNER.top - top0}px) scale(${CORNER.scale})`;
    });
    setTimeout(resolve, ms + 80);
  });
}