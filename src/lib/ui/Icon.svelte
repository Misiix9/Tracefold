<script lang="ts">
  let {
    name = 'note',
    size = 20,
    class: className = '',
  }: { name?: string; size?: number; class?: string } = $props();
  const files = import.meta.glob(
    '/node_modules/@phosphor-icons/core/assets/regular/{arrow-clockwise,arrow-counter-clockwise,arrow-left,arrow-up-right,arrows-out,camera,caret-down,chart-bar,chart-pie,check,clock,code,command,copy,desktop,dots-six-vertical,dots-three,download-simple,eye,file-text,files,folder-simple,gear-six,images,info,lightbulb,link,list-bullets,list-checks,lock-simple,magnifying-glass,moon,note,notebook,paperclip,pause,pencil-simple,play,play-circle,plus,question,shield-check,sun,table,text-b,text-italic,trash,upload-simple,warning,x}.svg',
    { eager: true, query: '?raw', import: 'default' },
  ) as Record<string, string>;
  const aliases: Record<string, string> = {
    note: 'notebook',
    file: 'file-text',
    finding: 'warning',
    evidence: 'images',
    reports: 'chart-bar',
    case: 'list-checks',
    run: 'play-circle',
    coverage: 'chart-pie',
    settings: 'gear-six',
    search: 'magnifying-glass',
    capture: 'camera',
    plus: 'plus',
    chevron: 'caret-down',
    back: 'arrow-left',
    close: 'x',
    check: 'check',
    pause: 'pause',
    play: 'play',
    attach: 'paperclip',
    trash: 'trash',
    more: 'dots-three',
    folder: 'folder-simple',
    template: 'files',
    arrow: 'arrow-up-right',
    sun: 'sun',
    moon: 'moon',
    download: 'download-simple',
    upload: 'upload-simple',
    link: 'link',
    info: 'info',
    question: 'question',
    idea: 'lightbulb',
    clock: 'clock',
    bold: 'text-b',
    italic: 'text-italic',
    list: 'list-bullets',
    code: 'code',
    table: 'table',
    undo: 'arrow-counter-clockwise',
    redo: 'arrow-clockwise',
    monitor: 'desktop',
    command: 'command',
    shield: 'shield-check',
    copy: 'copy',
    edit: 'pencil-simple',
    expand: 'arrows-out',
    eye: 'eye',
    lock: 'lock-simple',
    grip: 'dots-six-vertical',
  };
  const markup = $derived(
    files[
      '/node_modules/@phosphor-icons/core/assets/regular/' + (aliases[name] ?? name) + '.svg'
    ] ??
      files['/node_modules/@phosphor-icons/core/assets/regular/note.svg'] ??
      '',
  );
</script>

<span class="icon {className}" style:width="{size}px" style:height="{size}px" aria-hidden="true"
  >{@html markup}</span
>

<style>
  .icon {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    vertical-align: middle;
  }
  .icon :global(svg) {
    width: 100%;
    height: 100%;
    fill: currentColor;
  }
</style>
