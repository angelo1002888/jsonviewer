// js-yaml 懒加载包：首次识别到 YAML（或选 YAML 为目标）时由 formats.js 动态插入 <script> 加载
import { load, loadAll, dump, parseEvents, Schema, CORE_SCHEMA, DUMP_SCHEMA, NOT_RESOLVED, YAMLException, defineScalarTag, defineSequenceTag, defineMappingTag, mergeTag } from 'js-yaml';
window.JVYaml = { load, loadAll, dump, parseEvents, Schema, CORE_SCHEMA, DUMP_SCHEMA, NOT_RESOLVED, YAMLException, defineScalarTag, defineSequenceTag, defineMappingTag, mergeTag };
