'use strict';

import * as vscode from "vscode";
import * as util from "util";
import * as cp from "child_process";
import * as diff from "diff";
const untildify = require('untildify');

export const promiseExec = util.promisify(cp.exec);
export let registration: vscode.Disposable | undefined;

let progressBar: vscode.StatusBarItem;

export async function getJulia(): Promise<string> {
	// From https://github.com/julia-vscode/julia-vscode/blob/dd94db5/src/settings.ts#L8-L14
	let section = vscode.workspace.getConfiguration('julia');
	let jlpath = section ? untildify(section.get<string>('executablePath', 'julia')) : null;
	if (jlpath === "") {
		jlpath = null;
	}
	// From https://github.com/iansan5653/vscode-format-python-docstrings/blob/0135de8/src/extension.ts#L15-L45
	if (jlpath !== null) {
		try {
			await promiseExec(`"${jlpath}" --version`);
			return jlpath;
		} catch (err) {
			vscode.window.showErrorMessage(`
		  The Julia path set in the "julia.executablePath" setting is invalid. Check
		  the value or clear the setting to use the global Julia installation.
		`);
			throw err;
		}
	}
	try {
		await promiseExec("julia --version");
		return "julia";
	} catch {
		try {
			await promiseExec("jl --version");
			return "jl";
		} catch (err) {
			vscode.window.showErrorMessage(`
		  Julia is either not installed or not properly configured. Check that
		  the Julia location is set in VSCode or provided in the system
		  environment variables.
		`);
			throw err;
		}
	}
}

// From https://github.com/iansan5653/vscode-format-python-docstrings/blob/0135de8/src/extension.ts#L54-L72
export async function buildFormatCommand(path: string): Promise<string> {
	const julia = await getJulia();
	const settings = vscode.workspace.getConfiguration("juliaFormatter");
	// Abbreviated to keep template string short
	const margin = settings.get<number>("margin") || 92;
	const indent = settings.get<number>("indent") || 4;
	const afi = settings.get<boolean>("alwaysForIn") || true;
	const overwrite = settings.get<boolean>("overwrite") || true;
	const compile = settings.get<string>("compile") || "min";
	const whitespace_typedefs = settings.get<boolean>("whitespace_typedefs") || false;
	const whitespace_ops_in_indices = settings.get<boolean>("whitespace_ops_in_indices") || false;
	const epath = path.split('\\').join('\\\\');
	return [
		`${julia} --compile=${compile}`,
		`-e "using JuliaFormatter; format(\\\"${epath}\\\"; overwrite = ${overwrite}, indent = ${indent}, margin = ${margin}, always_for_in = ${afi}, whitespace_typedefs = ${whitespace_typedefs}, whitespace_ops_in_indices = ${whitespace_ops_in_indices})"`
	].join(' ').trim().replace(/\s+/, ' '); // Remove extra whitespace (helps with tests)
}

// From https://github.com/iansan5653/vscode-format-python-docstrings/blob/0135de8/src/extension.ts#L78-L90
export async function installDocformatter(): Promise<void> {
	const julia = await getJulia();
	try {
		await promiseExec(`${julia} -e "using Pkg; Pkg.update(); Pkg.add(\\\"JuliaFormatter\\\")"`);
	} catch (err) {
		vscode.window.showErrorMessage(`
		Could not install JuliaFormatter automatically. Make sure that it
		is installed correctly and try manually installing with
		'julia -e \"using Pkg; Pkg.add(\\\"JuliaFormatter\\\")\". \n\n Full error: ${err}'.
	  `);
		throw err;
	}
}

// From https://github.com/iansan5653/vscode-format-python-docstrings/blob/0135de8/src/extension.ts#L101-L132
export async function alertFormattingError(
	err: FormatException
): Promise<void> {
	if (
		err.message.includes("Package JuliaFormatter not found")
	) {
		const installButton = "Install Module";
		const response = await vscode.window.showErrorMessage(
			`The Julia package 'JuliaFormatter' must be installed to format files.`,
			installButton
		);
		if (response === installButton) {
			installDocformatter();
		}
	} else {
		const bugReportButton = "Submit Bug Report";
		const response = await vscode.window.showErrorMessage(
			`Unknown Error: Could not format file. Full error:\n\n
		  ${err.message}`,
			bugReportButton
		);
		if (response === bugReportButton) {
			vscode.commands.executeCommand(
				"vscode.open",
				vscode.Uri.parse(
					"https://github.com/singularitti/vscode-julia-formatter/issues/new"
				)
			);
		}
	}
}

// From https://github.com/iansan5653/vscode-format-python-docstrings/blob/0135de8/src/extension.ts#L142-L152
export async function formatFile(path: string): Promise<diff.Hunk[]> {
	const command: string = await buildFormatCommand(path);
	try {
		progressBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -1);
		progressBar.text = "Formatting...";
		progressBar.show();
		const result = await promiseExec(command);
		const parsed: diff.ParsedDiff[] = diff.parsePatch(result.stdout);
		progressBar.hide();
		return parsed[0].hunks;
	} catch (err) {
		alertFormattingError(err);
		throw err;
	}
}

// From https://github.com/iansan5653/vscode-format-python-docstrings/blob/0135de8/src/extension.ts#L159-L180
export function hunksToEdits(hunks: diff.Hunk[]): vscode.TextEdit[] {
	return hunks.map(
		(hunk): vscode.TextEdit => {
			const startPos = new vscode.Position(hunk.newStart - 1, 0);
			const endPos = new vscode.Position(
				hunk.newStart - 1 + hunk.oldLines - 1,
				hunk.lines[hunk.lines.length - 1].length - 1
			);
			const editRange = new vscode.Range(startPos, endPos);

			const newTextLines = hunk.lines
				.filter(
					(line): boolean => line.charAt(0) === " " || line.charAt(0) === "+"
				)
				.map((line): string => line.substr(1));
			const lineEndChar: string = hunk.linedelimiters[0];
			const newText = newTextLines.join(lineEndChar);

			return new vscode.TextEdit(editRange, newText);
		}
	);
}

export function activate(context: vscode.ExtensionContext) {
	vscode.languages.registerDocumentFormattingEditProvider('julia', {
		provideDocumentFormattingEdits(document: vscode.TextDocument): Promise<vscode.TextEdit[]> {
			return formatFile(document.fileName).then(hunksToEdits);
		}
	});
}

export interface FormatException {
	message: string;
}

// this method is called when your extension is deactivated
export function deactivate(): void {
	if (registration) {
		registration.dispose();
	}
}
