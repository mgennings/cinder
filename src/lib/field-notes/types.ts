export type NoteBlock =
	| { kind: 'heading'; level: 1 | 2 | 3; html: string }
	| { kind: 'paragraph'; html: string }
	| { kind: 'meta'; key: string; value: string }
	| { kind: 'coda'; html: string }
	| { kind: 'rule' }
	| { kind: 'table'; header: string[]; rows: string[][] }
	| { kind: 'code'; lines: string[] };

export type FieldNote = {
	number: string;
	title: string;
	date: string;
	gate: string;
	verdict: string;
	vote: string;
	blocks: NoteBlock[];
};
