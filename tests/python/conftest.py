import engine_corpus


def pytest_terminal_summary(terminalreporter):
    """Dice a fine run quanto hanno verificato i test sul corpus (#132).

    A fine run e non in testa (`pytest_report_header`): il conteggio serve a
    leggere il verde appena stampato, ed e' l'unico posto che sopravvive a
    `-q`, dove l'header non compare.
    """
    terminalreporter.write_line(engine_corpus.status_line())
