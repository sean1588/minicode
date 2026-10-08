package tasks

func Normalize(name string) string { return name }

// Process prepares a task name.
func Process(task Task) string { return Normalize(task.Name) }
