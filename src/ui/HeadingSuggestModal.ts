import { App, FuzzySuggestModal, HeadingCache } from "obsidian";

export class HeadingSuggestModal extends FuzzySuggestModal<HeadingCache | null> {
	constructor(app: App, private headings: HeadingCache[], private onChoose: (heading: HeadingCache | null) => void) {
		super(app);
		this.setPlaceholder("Choisir une section, ou laisser vide pour toute la note...");
	}

	getItems(): (HeadingCache | null)[] {
		return [null, ...this.headings];
	}

	getItemText(item: HeadingCache | null): string {
		if (!item) return "— Toute la note —";
		return `${"    ".repeat(item.level - 1)}${item.heading}`;
	}

	onChooseItem(item: HeadingCache | null): void {
		this.onChoose(item);
	}
}
