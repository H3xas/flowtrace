using Quill.Works.Finishes;
using Microsoft.AspNetCore.Mvc;

namespace Quill.Works.Controllers
{
    [ApiController]
    [Route("finishes/v1")]
    public class FinishController : ControllerBase
    {
        private readonly FinishRouter _router;

        public FinishController(FinishRouter router)
        {
            _router = router;
        }

        [HttpPost("matte")]
        public IActionResult Matte([FromBody] string item)
        {
            _router.Matte(item);
            return Ok();
        }

        [HttpPost("{kind}")]
        public IActionResult Apply(FinishKind kind, [FromBody] string item)
        {
            _router.ByKind(kind, item);
            return Ok();
        }

        [HttpPost("maybe/{kind}")]
        public IActionResult Maybe(FinishKind kind, [FromBody] string item)
        {
            _router.Maybe(kind, item);
            return Ok();
        }
    }
}
