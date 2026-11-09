package typemap

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// The TypeScript projects of a run, as astgen's findTypeProjects and partitionTypeGroups find
// them, so that each file is typed with the configuration that owns it. A directory below the
// source root is a nested project when it holds a tsconfig.json or jsconfig.json and some project
// file of the run lies under it. References are followed the way `tsc -b` follows them, so a
// configuration a solution-style one names (Angular's tsconfig.app.json) is found.

// TypeProject is one nested project: its directory, the configuration its program reads and the
// label budget records and the report use for it (its directory relative to the source root).
type TypeProject struct {
	Dir        string
	ConfigPath string
	Label      string
}

// TypeProjects is what FindTypeProjects returns. RootConfigPath is set only when the root's own
// configuration is solution-style and another configuration beside it types the root's files.
type TypeProjects struct {
	RootConfigPath string
	Projects       []TypeProject
}

// ProgramSpec describes the program one group of files is typed with. A nil spec, or one with no
// ProjectDirs, is the single program of a run without nested projects.
type ProgramSpec struct {
	Src         string   // where the configuration is searched for and @types roots start
	ConfigPath  string   // the configuration to read instead of searching from Src
	Label       string   // "." for the root program
	RunRoot     string   // the run's source root
	Dir         string   // the nested project's directory, "" for the root program
	ProjectDirs []string // every nested project's directory, deepest first
}

// TypeGroup is the files one program types and the project files it is rooted at.
type TypeGroup struct {
	Files        []string
	ProjectFiles []string
	Program      *ProgramSpec
}

type typeConfig struct {
	path       string
	files      json.RawMessage
	include    json.RawMessage
	references []string
	parsed     bool
}

func readTypeConfig(path string) (typeConfig, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return typeConfig{}, false
	}
	var m struct {
		Files      json.RawMessage `json:"files"`
		Include    json.RawMessage `json:"include"`
		References []struct {
			Path any `json:"path"`
		} `json:"references"`
	}
	if json.Unmarshal(stripJSONC(b), &m) != nil {
		return typeConfig{}, false
	}
	c := typeConfig{path: path, files: m.Files, include: m.Include, parsed: true}
	for _, r := range m.References {
		if s, ok := r.Path.(string); ok && strings.TrimSpace(s) != "" {
			c.references = append(c.references, s)
		}
	}
	return c, true
}

// isSolutionStyle: the configuration lists no files of its own and only references others.
func (c typeConfig) isSolutionStyle() bool {
	var files []any
	if len(c.files) == 0 || json.Unmarshal(c.files, &files) != nil || files == nil {
		return false
	}
	return len(files) == 0 && len(c.include) == 0 && len(c.references) > 0
}

// rank orders the configurations that share a directory: one that lists files before a
// solution-style one, then tsconfig.json, jsconfig.json and the alphabetically first name.
func (c typeConfig) rank() string {
	name := strings.ToLower(filepath.Base(c.path))
	canonical := "2"
	switch name {
	case "tsconfig.json":
		canonical = "0"
	case "jsconfig.json":
		canonical = "1"
	}
	solution := "0"
	if c.isSolutionStyle() {
		solution = "1"
	}
	return solution + canonical + "\x00" + name
}

// resolveProjectReferencePath: a reference names a configuration file, or a directory whose
// tsconfig.json it means.
func resolveProjectReferencePath(p string) string {
	if strings.HasSuffix(strings.ToLower(p), ".json") {
		return p
	}
	return filepath.Join(p, "tsconfig.json")
}

// FindTypeProjects mirrors astgen's findTypeProjects.
func FindTypeProjects(projectFiles []string, src string) TypeProjects {
	srcRoot, err := filepath.Abs(src)
	if err != nil {
		return TypeProjects{}
	}
	rootConfig := findConfigFile(srcRoot)
	rootConfigDir := srcRoot
	if rootConfig != "" {
		rootConfigDir = filepath.Dir(rootConfig)
	}
	byDir := map[string][]typeConfig{}
	visited := map[string]bool{}
	var consider func(string)
	consider = func(configPath string) {
		path, err := filepath.Abs(configPath)
		if err != nil || visited[path] {
			return
		}
		if st, err := os.Stat(path); err != nil || st.IsDir() {
			return
		}
		visited[path] = true
		c, ok := readTypeConfig(path)
		if !ok {
			return
		}
		dir := filepath.Dir(path)
		if dir == rootConfigDir || IsUnderRoot(dir, srcRoot) {
			byDir[dir] = append(byDir[dir], c)
		}
		for _, ref := range c.references {
			consider(resolveProjectReferencePath(filepath.Join(dir, ref)))
		}
	}
	if rootConfig != "" {
		consider(rootConfig)
	}
	fileDirs := map[string]bool{}
	for _, f := range projectFiles {
		abs, err := filepath.Abs(f)
		if err != nil {
			continue
		}
		for dir := filepath.Dir(abs); IsUnderRoot(dir, srcRoot) && !fileDirs[dir]; dir = filepath.Dir(dir) {
			fileDirs[dir] = true
		}
	}
	dirs := make([]string, 0, len(fileDirs))
	for d := range fileDirs {
		dirs = append(dirs, d)
	}
	sort.Strings(dirs)
	for _, d := range dirs {
		consider(filepath.Join(d, "tsconfig.json"))
		consider(filepath.Join(d, "jsconfig.json"))
	}
	chosen := func(dir string) string {
		cs := append([]typeConfig(nil), byDir[dir]...)
		sort.SliceStable(cs, func(i, j int) bool { return cs[i].rank() < cs[j].rank() })
		return cs[0].path
	}
	var out TypeProjects
	if _, ok := byDir[rootConfigDir]; ok && rootConfig != "" {
		if c := chosen(rootConfigDir); c != rootConfig {
			out.RootConfigPath = c
		}
	}
	var projectDirs []string
	for dir := range byDir {
		if dir != rootConfigDir && fileDirs[dir] {
			projectDirs = append(projectDirs, dir)
		}
	}
	sort.Strings(projectDirs)
	for _, dir := range projectDirs {
		rel, _ := filepath.Rel(srcRoot, dir)
		out.Projects = append(out.Projects, TypeProject{Dir: dir, ConfigPath: chosen(dir), Label: filepath.ToSlash(rel)})
	}
	return out
}

// typeProjectDirOf is the directory of the deepest nested project that holds file, given the
// project directories deepest first, or "" when the root program types it.
func typeProjectDirOf(file string, projectDirs []string) string {
	for _, d := range projectDirs {
		if IsUnderRoot(file, d) {
			return d
		}
	}
	return ""
}

// isOtherProjectsFile: a file the program's configuration lists that belongs to another project of
// the run, and so is left to that project's program.
func (p *ProgramSpec) isOtherProjectsFile(file string) bool {
	if p == nil || p.ProjectDirs == nil {
		return false
	}
	return IsUnderRoot(file, p.RunRoot) && typeProjectDirOf(file, p.ProjectDirs) != p.Dir
}

// PartitionTypeGroups mirrors astgen's partitionTypeGroups: a file belongs to the deepest nested
// project whose directory holds it, else to the root program, and each group keeps the input
// order. Without nested projects there is one group, typed as before.
func PartitionTypeGroups(files, projectFiles []string, tp TypeProjects, src string) []TypeGroup {
	if len(tp.Projects) == 0 {
		var spec *ProgramSpec
		if tp.RootConfigPath != "" {
			spec = &ProgramSpec{ConfigPath: tp.RootConfigPath}
		}
		return []TypeGroup{{Files: files, ProjectFiles: projectFiles, Program: spec}}
	}
	runRoot, _ := filepath.Abs(src)
	projectDirs := make([]string, 0, len(tp.Projects))
	for _, p := range tp.Projects {
		projectDirs = append(projectDirs, p.Dir)
	}
	sort.SliceStable(projectDirs, func(i, j int) bool {
		if len(projectDirs[i]) != len(projectDirs[j]) {
			return len(projectDirs[i]) > len(projectDirs[j])
		}
		return projectDirs[i] < projectDirs[j]
	})
	groups := []TypeGroup{{Program: &ProgramSpec{Src: runRoot, ConfigPath: tp.RootConfigPath, Label: ".", RunRoot: runRoot, ProjectDirs: projectDirs}}}
	index := map[string]int{"": 0}
	for _, p := range tp.Projects {
		index[p.Dir] = len(groups)
		groups = append(groups, TypeGroup{Program: &ProgramSpec{Src: p.Dir, ConfigPath: p.ConfigPath, Label: p.Label, RunRoot: runRoot, Dir: p.Dir, ProjectDirs: projectDirs}})
	}
	for _, f := range files {
		g := &groups[index[typeProjectDirOf(absOr(f), projectDirs)]]
		g.Files = append(g.Files, f)
	}
	for _, f := range projectFiles {
		g := &groups[index[typeProjectDirOf(absOr(f), projectDirs)]]
		g.ProjectFiles = append(g.ProjectFiles, f)
	}
	out := groups[:0]
	for _, g := range groups {
		if len(g.Files) > 0 {
			out = append(out, g)
		}
	}
	return out
}

func absOr(f string) string {
	if a, err := filepath.Abs(f); err == nil {
		return a
	}
	return f
}
