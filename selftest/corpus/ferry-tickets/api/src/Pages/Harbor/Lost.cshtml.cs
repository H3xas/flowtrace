namespace Ferry.Api.Pages.Harbor;

[Route(HarborRoutes.LostProperty)]
public class LostModel : PageModel
{
    public IActionResult OnGet()
    {
        return Page();
    }
}
