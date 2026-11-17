using Microsoft.AspNetCore.Mvc;

namespace Lock.Keeper.Controllers
{
    [ApiController]
    [Route("lock/v1/passages")]
    public class PassagesController : ControllerBase
    {
        [HttpPost]
        public IActionResult Save([FromBody] object passage)
        {
            return Ok();
        }

        [HttpGet("{passageId}")]
        public IActionResult Load(string passageId)
        {
            return Ok();
        }
    }
}
