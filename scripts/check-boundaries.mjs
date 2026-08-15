import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const projectRoots = ['apps', 'packages'];
const sourceExtensions = new Set(['.js', '.mjs', '.ts', '.vue']);

async function existingDirectories(parent) {
  const entries = await readdir(path.join(root, parent), {
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, parent, entry.name));
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(entryPath);
      return sourceExtensions.has(path.extname(entry.name)) ? [entryPath] : [];
    }),
  );
  return nested.flat();
}

function workspaceName(specifier) {
  if (!specifier.startsWith('@')) return specifier.split('/')[0];
  return specifier.split('/').slice(0, 2).join('/');
}

function owningProject(filePath, projects) {
  return projects.find(
    (project) =>
      filePath === project.directory ||
      filePath.startsWith(`${project.directory}${path.sep}`),
  );
}

function detectCycles(graph) {
  const visiting = new Set();
  const visited = new Set();
  const failures = [];

  function visit(node, route) {
    if (visiting.has(node)) {
      const cycleStart = route.indexOf(node);
      failures.push(
        `workspace dependency cycle: ${[...route.slice(cycleStart), node].join(' -> ')}`,
      );
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    for (const dependency of graph.get(node) ?? [])
      visit(dependency, [...route, node]);
    visiting.delete(node);
    visited.add(node);
  }

  for (const node of graph.keys()) visit(node, []);
  return failures;
}

const directories = (
  await Promise.all(projectRoots.map(existingDirectories))
).flat();
const projects = await Promise.all(
  directories.map(async (directory) => {
    const manifest = JSON.parse(
      await readFile(path.join(directory, 'package.json'), 'utf8'),
    );
    return { directory, manifest, name: manifest.name };
  }),
);
const projectByName = new Map(
  projects.map((project) => [project.name, project]),
);
const graph = new Map(projects.map((project) => [project.name, new Set()]));
const failures = [];
const importPattern =
  /(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

for (const project of projects) {
  const declarations = {
    ...project.manifest.dependencies,
    ...project.manifest.devDependencies,
    ...project.manifest.peerDependencies,
  };
  for (const dependencyName of Object.keys(declarations)) {
    const dependency = projectByName.get(dependencyName);
    if (!dependency) continue;
    graph.get(project.name)?.add(dependencyName);
    if (
      project.directory.includes(`${path.sep}packages${path.sep}`) &&
      dependency.directory.includes(`${path.sep}apps${path.sep}`)
    ) {
      failures.push(
        `${project.name} must not depend on application ${dependencyName}`,
      );
    }
    if (
      project.directory.includes(`${path.sep}apps${path.sep}`) &&
      dependency.directory.includes(`${path.sep}apps${path.sep}`)
    ) {
      failures.push(
        `${project.name} must not depend on application ${dependencyName}`,
      );
    }
  }
}

for (const project of projects) {
  const files = await sourceFiles(path.join(project.directory, 'src'));
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2];
      if (!specifier) continue;
      if (specifier.startsWith('.')) {
        const target = path.resolve(path.dirname(file), specifier);
        const targetProject = owningProject(target, projects);
        if (targetProject && targetProject.name !== project.name) {
          failures.push(
            `${path.relative(root, file)} imports across a project boundary with ${specifier}`,
          );
        }
        continue;
      }

      const dependencyName = workspaceName(specifier);
      const dependency = projectByName.get(dependencyName);
      if (!dependency) continue;
      const declarations = {
        ...project.manifest.dependencies,
        ...project.manifest.devDependencies,
        ...project.manifest.peerDependencies,
      };
      if (!(dependencyName in declarations)) {
        failures.push(
          `${path.relative(root, file)} imports undeclared workspace dependency ${dependencyName}`,
        );
      }
      if (
        specifier === dependencyName &&
        (!dependency.manifest.exports || !('.' in dependency.manifest.exports))
      ) {
        failures.push(
          `${dependencyName} does not declare its root package export`,
        );
      } else if (specifier !== dependencyName) {
        const subpath = `.${specifier.slice(dependencyName.length)}`;
        if (
          !dependency.manifest.exports ||
          !(subpath in dependency.manifest.exports)
        ) {
          failures.push(
            `${path.relative(root, file)} imports undeclared export ${specifier}`,
          );
        }
      }
    }
  }
}

failures.push(...detectCycles(graph));
if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    `Dependency boundaries valid for ${projects.length} workspace projects.`,
  );
}
