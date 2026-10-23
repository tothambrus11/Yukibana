/**
 * The window layout, made with dockview: the explorer on the left, editor
 * tabs in the middle (one Monaco editor per open file), problems and output
 * on the right. Every panel can be dragged, split and resized; editor tabs
 * close, the fixed panels do not.
 */
import {
	createDockview,
	type DockviewApi,
	type GroupPanelPartInitParameters,
	type IContentRenderer,
	type IDockviewPanel,
	type ITabRenderer,
	type TabPartInitParameters,
} from 'dockview';
import 'dockview/dist/styles/dockview.css';
import { mount, unmount, type Component } from 'svelte';
import { EDITOR_FONT, monaco } from './monaco';
import { NavigationHistory, type Place } from './history';
import { baseName } from './project';
import { pathOf, type EditorHost, type Workspace } from './workspace.svelte';
import Explorer from './components/Explorer.svelte';
import Problems from './components/Problems.svelte';
import Output from './components/Output.svelte';
import Terminal from './components/Terminal.svelte';

const EDITOR_PREFIX = 'file:';
const editorId = (path: string) => EDITOR_PREFIX + path;
const isEditor = (panel: IDockviewPanel) => panel.id.startsWith(EDITOR_PREFIX);

/** A dockview content renderer that shows a Svelte component. */
class SvelteRenderer implements IContentRenderer {
	readonly element = document.createElement('div');
	private instance: ReturnType<typeof mount> | null = null;

	constructor(
		private readonly component: Component<{ workspace: Workspace }>,
		private readonly workspace: Workspace,
	) {
		this.element.className = 'dock-panel';
	}

	init(): void {
		this.instance = mount(this.component, { target: this.element, props: { workspace: this.workspace } });
	}

	dispose(): void {
		if (this.instance) void unmount(this.instance);
	}
}

/** A dockview content renderer holding one Monaco editor on one project file. */
class EditorRenderer implements IContentRenderer {
	readonly element = document.createElement('div');
	editor: monaco.editor.IStandaloneCodeEditor | null = null;
	/** The project file shown. */
	path = '';

	constructor(
		private readonly workspace: Workspace,
		private readonly navigation: Navigation,
	) {
		this.element.className = 'dock-editor';
	}

	init(params: GroupPanelPartInitParameters): void {
		const path = String(params.params['path']);
		this.path = path;
		const model = this.workspace.model(path);
		this.editor = monaco.editor.create(this.element, {
			model: model ?? null,
			automaticLayout: true,
			fontFamily: EDITOR_FONT,
			fontSize: 13.5,
			lineHeight: 21,
			fontLigatures: false,
			minimap: { enabled: false },
			scrollBeyondLastLine: false,
			renderLineHighlight: 'all',
			padding: { top: 10 },
			'semanticHighlighting.enabled': true,
			fixedOverflowWidgets: true,
			tabSize: 4,
		});
		const editor = this.editor;
		editor.onDidChangeCursorPosition((e) => this.navigation.record({ path, line: e.position.lineNumber, column: e.position.column }));
		// VS Code's keys: Alt+Left/Right, Ctrl+- / Ctrl+Shift+- on macOS (where Alt+Left moves by word).
		const mac = /Mac|iPhone|iPad/.test(navigator.platform);
		const { KeyMod, KeyCode } = monaco;
		editor.addAction({
			id: 'yukibana.navigateBack',
			label: 'Go Back',
			keybindings: [mac ? KeyMod.WinCtrl | KeyCode.Minus : KeyMod.Alt | KeyCode.LeftArrow],
			run: () => this.navigation.back(),
		});
		editor.addAction({
			id: 'yukibana.navigateForward',
			label: 'Go Forward',
			keybindings: [mac ? KeyMod.WinCtrl | KeyMod.Shift | KeyCode.Minus : KeyMod.Alt | KeyCode.RightArrow],
			run: () => this.navigation.forward(),
		});
		editor.addAction({
			id: 'yukibana.run',
			label: 'Run Project',
			keybindings: [KeyMod.CtrlCmd | KeyCode.Enter],
			run: () => this.workspace.run(),
		});
	}

	focus(): void {
		this.editor?.focus();
	}

	dispose(): void {
		this.editor?.dispose();
	}
}

/** What an editor needs to take part in back/forward navigation. */
interface Navigation {
	record(place: Place): void;
	back(): void;
	forward(): void;
}

/** A tab with a title and, for editors, a close button and an error dot. */
class TabRenderer implements ITabRenderer {
	readonly element = document.createElement('div');
	private readonly label = document.createElement('span');

	constructor(private readonly closable: boolean) {
		this.element.className = 'dock-tab';
		this.element.append(this.label);
	}

	init(params: TabPartInitParameters): void {
		this.label.textContent = params.title ?? '';
		params.api.onDidTitleChange((e) => (this.label.textContent = e.title));
		if (!this.closable) return;
		const close = document.createElement('button');
		close.className = 'dock-tab-close';
		close.title = 'Close';
		close.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
		close.addEventListener('pointerdown', (e) => e.stopPropagation());
		close.addEventListener('click', (e) => {
			e.stopPropagation();
			params.api.close();
		});
		this.element.append(close);
	}
}

/**
 * Builds the layout in `element` and returns the workspace's editor host.
 * Tabs and the active file are reported back to the workspace so they are
 * saved with the project.
 */
export function createDock(element: HTMLElement, workspace: Workspace): EditorHost & { setProblemCount(n: number): void; dispose(): void } {
	const editors = new Map<string, EditorRenderer>();
	const history = new NavigationHistory();
	const exists = (path: string) => workspace.model(path) !== undefined;
	const goTo = (place: Place | null) => {
		if (place) host.open(place.path, monaco.Range.fromPositions({ lineNumber: place.line, column: place.column }));
	};
	const navigation: Navigation = {
		record: (place) => history.record(place),
		back: () => goTo(history.back(exists)),
		forward: () => goTo(history.forward(exists)),
	};
	let lastEditor: string | null = null;
	let replacing = false;
	/** True while `open` changes tabs: it records where it lands itself, after placing the cursor. */
	let opening = false;

	const dock: DockviewApi = createDockview(element, {
		className: 'dockview-theme-yukibana',
		disableFloatingGroups: true,
		createComponent: ({ id, name }) => {
			switch (name) {
				case 'explorer':
					return new SvelteRenderer(Explorer, workspace);
				case 'problems':
					return new SvelteRenderer(Problems, workspace);
				case 'output':
					return new SvelteRenderer(Output, workspace);
				case 'terminal':
					return new SvelteRenderer(Terminal, workspace);
				default: {
					const r = new EditorRenderer(workspace, navigation);
					editors.set(id, r);
					return r;
				}
			}
		},
		createTabComponent: ({ name }) => new TabRenderer(name === 'editor'),
	});

	const explorer = dock.addPanel({ id: 'explorer', component: 'explorer', tabComponent: 'fixed', title: 'Explorer' });
	const terminal = dock.addPanel({ id: 'terminal', component: 'terminal', tabComponent: 'fixed', title: 'Terminal', position: { referencePanel: explorer, direction: 'right' } });
	const output = dock.addPanel({ id: 'output', component: 'output', tabComponent: 'fixed', title: 'Output', position: { referencePanel: terminal, direction: 'within' }, inactive: true });
	dock.addPanel({ id: 'problems', component: 'problems', tabComponent: 'fixed', title: 'Problems', position: { referencePanel: output, direction: 'within' }, inactive: true });
	// The editors' group exists from the start, so the side columns can be
	// sized once against the whole width; editors open into it.
	let editorArea = dock.addGroup({ referencePanel: terminal, direction: 'left' });
	dock.layout(element.clientWidth, element.clientHeight);
	explorer.group.api.setSize({ width: 240 });
	terminal.group.api.setSize({ width: Math.round(element.clientWidth * 0.3) });

	const report = () => {
		if (replacing) return;
		const open = dock.panels.filter(isEditor).map((p) => p.id.slice(EDITOR_PREFIX.length));
		const active = dock.activePanel;
		if (active && isEditor(active)) {
			lastEditor = active.id.slice(EDITOR_PREFIX.length);
			// Switching tabs moves no cursor, but is a place to come back to.
			const position = editors.get(active.id)?.editor?.getPosition();
			if (position && !opening) history.record({ path: lastEditor, line: position.lineNumber, column: position.column });
		}
		if (lastEditor && !open.includes(lastEditor)) lastEditor = open.at(-1) ?? null;
		workspace.tabsChanged(open, lastEditor);
	};
	// The mouse's back and forward buttons do the same, anywhere in the layout.
	const mouseButtons = (e: MouseEvent) => {
		if (e.button !== 3 && e.button !== 4) return;
		e.preventDefault();
		if (e.button === 3) navigation.back();
		else navigation.forward();
	};
	element.addEventListener('mouseup', mouseButtons);
	const disposables = [
		{ dispose: () => element.removeEventListener('mouseup', mouseButtons) },
		dock.onDidAddPanel(report),
		dock.onDidRemovePanel((panel) => {
			editors.delete(panel.id);
			report();
		}),
		dock.onDidActivePanelChange(report),
		monaco.editor.registerEditorOpener({
			openCodeEditor: (_source, resource, selection) => {
				const path = pathOf(resource);
				if (path === null || !workspace.model(path)) return false;
				host.open(path, selection && 'startLineNumber' in selection ? selection : selection ? monaco.Range.fromPositions(selection) : undefined);
				return true;
			},
		}),
	];

	/** Where a new editor goes: the editors' group while it exists, else a new one left of the output. */
	const editorGroup = () => {
		if (!dock.groups.includes(editorArea)) {
			editorArea = dock.groups.find((g) => g.panels.some(isEditor)) ?? dock.addGroup({ referencePanel: 'terminal', direction: 'left' });
		}
		return editorArea;
	};

	const host = {
		open(path: string, selection?: monaco.IRange): void {
			const id = editorId(path);
			opening = true;
			try {
				const panel = dock.getPanel(id);
				if (panel) panel.api.setActive();
				else {
					dock.addPanel({
						id,
						component: 'editor',
						tabComponent: 'editor',
						title: baseName(path),
						params: { path },
						position: { referenceGroup: editorGroup() },
					});
				}
			} finally {
				opening = false;
			}
			const editor = editors.get(id)?.editor;
			if (editor && selection) {
				editor.setSelection(selection);
				editor.revealRangeInCenterIfOutsideViewport(selection);
			}
			const position = editor?.getPosition();
			if (position) history.record({ path, line: position.lineNumber, column: position.column });
			editor?.focus();
		},
		close(path: string): void {
			dock.getPanel(editorId(path))?.api.close();
		},
		closeAll(): void {
			replacing = true;
			for (const panel of dock.panels.filter(isEditor)) panel.api.close();
			replacing = false;
			lastEditor = null;
			history.clear();
		},
		showTerminal(): void {
			dock.getPanel('terminal')?.api.setActive();
		},
		setProblemCount(n: number): void {
			dock.getPanel('problems')?.api.setTitle(n ? `Problems ${n}` : 'Problems');
		},
		dispose(): void {
			for (const d of disposables) d.dispose();
			dock.dispose();
		},
	};
	return host;
}
