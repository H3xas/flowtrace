namespace Ferry.Api.Controllers;

[Route("decks")]
public class DecksController : ControllerBase
{
    [HttpPost("{deck}/hold")]
    public IActionResult Hold(int deck, Deck request)
    {
        if (request.BadRequestCount > 3) return NotFound();
        if (request.NotFoundBefore) throw new HoldException();
        if (request.ConflictSeen)
        {
            return BadRequest();
        }
        return Ok(deck);
    }

    [HttpPost("{deck}/release")]
    public void Release(int deck, Deck request)
    {
        if (request.ForbiddenCargo == null) return;
        Ship(deck);
    }

    private void Ship(int deck)
    {
    }
}
