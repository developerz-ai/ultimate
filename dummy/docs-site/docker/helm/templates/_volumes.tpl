{{/*
The writable scratch every pod mounts at /tmp — the root filesystem is read-only. Bounded, because
an emptyDir with no sizeLimit is node disk: one role filling /tmp evicts its NEIGHBOURS for disk
pressure, where with a limit the kubelet evicts that pod alone.
*/}}
{{- define "docs-site.tmpVolume" -}}
- name: tmp
  emptyDir:
    sizeLimit: {{ required "tmp.sizeLimit is unset — set it in your values (e.g. 512Mi): an unbounded /tmp is node disk" (default dict .Values.tmp).sizeLimit | quote }}
{{- end -}}
