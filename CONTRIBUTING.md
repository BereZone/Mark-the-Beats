# Contributing

## Commit Messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`.

Breaking changes must include `BREAKING CHANGE:` in the footer or `!` after the type.

## Changelog

Maintain [`CHANGELOG.md`](CHANGELOG.md) in [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. Add entries under `[Unreleased]` as you work; they get moved to a versioned section on release.

## Versioning

Releases follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html):

- `MAJOR` — breaking changes to the plugin API or manifest
- `MINOR` — new user-facing features, backwards compatible
- `PATCH` — bug fixes, backwards compatible

## Development

See [`docs/development.md`](docs/development.md) for setup instructions.
