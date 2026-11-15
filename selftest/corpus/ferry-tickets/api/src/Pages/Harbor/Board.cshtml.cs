namespace Ferry.Api.Pages.Harbor;

[Route(
    "harbor/departures")] // the public board
public class BoardModel : PageModel
{
    private readonly Timetable _timetable;

    public BoardModel(Timetable timetable)
    {
        _timetable = timetable;
    }

    public IActionResult OnGet()
    {
        return Page(_timetable.Today());
    }
}
