package tasks

// Task represents a unit of work.
type Task struct { Name string }

// Label returns the task name.
func (t *Task) Label() string { return t.Name }

type Runner interface { Run(Task) string }
type ID = string
const DefaultName = "work"
