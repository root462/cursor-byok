import { useLayoutEffect, useRef } from "react";
import { createDisplacementMap } from "./displacementMap";

const SVG_NS = "http://www.w3.org/2000/svg";
const SELECTOR = ".liquid-refractive";

/** Owns the edge-refraction maps for cards and the floating toolbar. */
export function LiquidGlassFilter() {
  const definitions = useRef<SVGDefsElement>(null);

  useLayoutEffect(() => {
    const defs = definitions.current;
    if (!defs) return;
    const surfaces = new Map<HTMLElement, {
      filter: SVGFilterElement;
      image: SVGFEImageElement;
      displacement: SVGFEDisplacementMapElement;
      geometry: string;
    }>();
    let frame = 0;

    function sync() {
      frame = 0;
      const elements = new Set(document.querySelectorAll<HTMLElement>(SELECTOR));
      for (const [element, surface] of surfaces) {
        if (elements.has(element)) continue;
        observer.unobserve(element);
        element.style.removeProperty("--liquid-refraction");
        surface.filter.remove();
        surfaces.delete(element);
      }
      for (const element of elements) {
        // Use layout dimensions: scrolling and entrance transforms do not
        // change the material, so they must not regenerate its texture.
        const width = element.offsetWidth;
        const height = element.offsetHeight;
        const style = getComputedStyle(element);
        if (!width || !height || style.backdropFilter === "none") continue;
        const corner = style.borderTopLeftRadius.split(" ")[0];
        const radius = Math.min(
          corner.endsWith("%")
            ? parseFloat(corner) / 100 * Math.min(width, height)
            : parseFloat(corner) || 0,
          width / 2,
          height / 2,
        );
        let surface = surfaces.get(element);
        if (!surface) {
          const filter = document.createElementNS(SVG_NS, "filter");
          filter.id = `liquid-${crypto.randomUUID()}`;
          filter.setAttribute("filterUnits", "userSpaceOnUse");
          filter.setAttribute("primitiveUnits", "userSpaceOnUse");
          filter.setAttribute("color-interpolation-filters", "sRGB");
          filter.setAttribute("x", "0");
          filter.setAttribute("y", "0");
          const image = document.createElementNS(SVG_NS, "feImage");
          image.setAttribute("result", "map");
          image.setAttribute("preserveAspectRatio", "none");
          const displacement = document.createElementNS(SVG_NS, "feDisplacementMap");
          displacement.setAttribute("in", "SourceGraphic");
          displacement.setAttribute("in2", "map");
          displacement.setAttribute("xChannelSelector", "R");
          displacement.setAttribute("yChannelSelector", "G");
          filter.append(image, displacement);
          defs!.append(filter);
          surface = { filter, image, displacement, geometry: "" };
          surfaces.set(element, surface);
        }
        observer.observe(element, { box: "border-box" });
        const geometry = `${width}:${height}:${radius}`;
        if (surface.geometry === geometry) continue;
        const map = createDisplacementMap(width, height, radius);
        surface.filter.setAttribute("width", String(width));
        surface.filter.setAttribute("height", String(height));
        surface.image.setAttribute("width", String(width));
        surface.image.setAttribute("height", String(height));
        surface.image.setAttribute("href", map.href);
        surface.displacement.setAttribute("scale", String(map.scale));
        element.style.setProperty("--liquid-refraction", `url("#${surface.filter.id}")`);
        surface.geometry = geometry;
      }
    }

    function schedule() {
      if (!frame) frame = requestAnimationFrame(sync);
    }

    const observer = new ResizeObserver(schedule);
    const mutations = new MutationObserver((records) => {
      if (records.some((record) => !defs.contains(record.target))) schedule();
    });
    mutations.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class"],
    });
    sync();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      mutations.disconnect();
      for (const [element, surface] of surfaces) {
        element.style.removeProperty("--liquid-refraction");
        surface.filter.remove();
      }
    };
  }, []);

  return (
    <svg aria-hidden="true" width="0" height="0" style={{ position: "absolute", pointerEvents: "none" }}>
      <defs ref={definitions} />
    </svg>
  );
}
