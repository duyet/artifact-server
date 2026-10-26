import {toast} from "sonner";

/** Copy `text` to the clipboard and raise a toast for the outcome. */
export async function copyText(
  text: string,
  successMessage: string,
  failureMessage = "The link could not be copied.",
): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(successMessage);
  } catch {
    toast.error(failureMessage);
  }
}
