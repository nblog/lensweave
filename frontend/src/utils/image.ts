/**
 * Image helpers shared between the EP workshop canvas and the asset library.
 * Reading an uploaded file into a data URI lets both surfaces store/preview an
 * image inline without a separate upload endpoint (docs/04 §2.4, §3.3).
 */

/** Image MIME types accepted by file pickers across the app. */
export const ACCEPTED_IMAGE_TYPES = "image/png,image/jpeg,image/webp";

/** Read a picked file as a base64 data URI and hand it to `onLoad`. */
export function readImageAsDataUri(file: File, onLoad: (uri: string) => void): void {
  const reader = new FileReader();
  reader.addEventListener("load", () => {
    if (typeof reader.result === "string") {
      onLoad(reader.result);
    }
  });
  reader.readAsDataURL(file);
}

/** Trigger a browser download of an image src (data URI or remote URL). */
export function downloadImage(src: string, title: string): void {
  triggerDownload(src, imageDownloadName(src, title));
}

function imageDownloadName(src: string, title: string): string {
  const safeTitle =
    title
      .trim()
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, "-")
      .slice(0, 60) || "image";
  return `${safeTitle}.${imageExtensionFromSrc(src)}`;
}

function triggerDownload(href: string, filename: string): void {
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  link.target = "_blank";
  link.rel = "noreferrer";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function imageExtensionFromSrc(src: string): string {
  if (src.startsWith("data:image/")) {
    const subtype = src.slice("data:image/".length).split(/[;,]/)[0];
    if (subtype === "jpeg") return "jpg";
    if (/^[a-z0-9.+-]+$/i.test(subtype)) return subtype.split("+")[0];
  }
  const path = src.split(/[?#]/, 1)[0].toLowerCase();
  const match = path.match(/\.(png|jpe?g|webp|gif)$/);
  if (!match) return "png";
  return match[1] === "jpeg" ? "jpg" : match[1];
}
