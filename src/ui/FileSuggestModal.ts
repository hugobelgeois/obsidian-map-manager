import { App, FuzzySuggestModal, TFile } from "obsidian";

export class FileSuggestModal extends FuzzySuggestModal<TFile> {
	constructor(app: App, private files: TFile[], private onChoose: (file: TFile) => void, placeholder = "Choisir un fichier...") {
		super(app);
		this.setPlaceholder(placeholder);
	}

	getItems(): TFile[] {
		return this.files;
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		this.onChoose(file);
	}
}

export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"];
