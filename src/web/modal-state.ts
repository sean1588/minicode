export function syncBodyModalOpenState(): void {
  const anyModalOpen = [...document.querySelectorAll<HTMLElement>(".modal")]
    .some((modal) => !modal.classList.contains("hidden"));
  document.body.classList.toggle("modal-open", anyModalOpen);
}

export function openModal(modal: HTMLElement): void {
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  syncBodyModalOpenState();
}

export function closeModal(modal: HTMLElement): void {
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
  syncBodyModalOpenState();
}
